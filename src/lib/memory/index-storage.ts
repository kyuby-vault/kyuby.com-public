import type { PGlite } from '@electric-sql/pglite';

export const PGLITE_NAMESPACE = '/kyuby-pglite/v1/';
const CHECKPOINT_LIMIT = 64 * 1024 * 1024;
const SIDECAR_LIMIT = 1024;

interface CheckpointMetadata { highWaterSeq: number; writtenAt: number }

async function writeFile(directory: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const stream = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try { await stream.write(data); await stream.close(); }
  catch (error) { await stream.abort().catch(() => undefined); throw error; }
}

async function readMetadata(directory: FileSystemDirectoryHandle): Promise<CheckpointMetadata | undefined> {
  try {
    const file = await (await directory.getFileHandle('checkpoint.json')).getFile();
    if (!file.size || file.size > SIDECAR_LIMIT) throw new Error('Invalid index checkpoint metadata size.');
    const value = JSON.parse(await file.text());
    if (!value || !Number.isSafeInteger(value.highWaterSeq) || value.highWaterSeq < 0
      || !Number.isSafeInteger(value.writtenAt) || value.writtenAt < 0) throw new Error('Invalid index checkpoint metadata.');
    return value;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}

export interface IndexStorage {
  load(): Promise<Blob | undefined>;
  save(database: PGlite): Promise<void>;
  remove(): Promise<void>;
}

export class OpfsIndexStorage implements IndexStorage {
  async exclusive<Result>(action: () => Promise<Result>): Promise<Result> {
    return navigator.locks ? navigator.locks.request('kyuby-pglite:v1:checkpoint', action) : action();
  }
  async directory(create: boolean): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle('kyuby-pglite', { create });
    return parent.getDirectoryHandle('v1', { create });
  }

  async load(): Promise<Blob | undefined> {
    return this.exclusive(async () => {
      try {
        const directory = await this.directory(false);
        const checkpoint = await (await directory.getFileHandle('index.tar.gz')).getFile();
        if (checkpoint.size === 0 || checkpoint.size > CHECKPOINT_LIMIT) throw new Error('Invalid index checkpoint size.');
        return new Blob([await checkpoint.arrayBuffer()]);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
        throw error;
      }
    });
  }

  async save(database: PGlite): Promise<void> {
    await this.exclusive(async () => {
      const directory = await this.directory(true);
      const result = await database.query<{ value: string }>("SELECT value FROM meta WHERE key='highWaterSeq'");
      const highWaterSeq = Number(result.rows[0]?.value);
      if (!Number.isSafeInteger(highWaterSeq) || highWaterSeq < 0) throw new Error('Invalid checkpoint high-water sequence.');
      const previous = await readMetadata(directory);
      if (previous && previous.highWaterSeq > highWaterSeq) return;
      const checkpoint = await database.dumpDataDir('gzip');
      if (checkpoint.size > CHECKPOINT_LIMIT) throw new Error('Memory index checkpoint exceeds its storage budget.');
      // Reserve the guard first, under the same Web Lock. A crash before the data
      // close may leave an older checkpoint, but cannot let a stale writer replace
      // a newer one. Boot still trusts the checkpoint's own meta and replays IDB.
      await writeFile(directory, 'checkpoint.json', JSON.stringify({ highWaterSeq, writtenAt: Date.now() }));
      await writeFile(directory, 'index.tar.gz', checkpoint);
    });
  }

  async remove(): Promise<void> {
    await this.exclusive(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const parent = await root.getDirectoryHandle('kyuby-pglite');
        await parent.removeEntry('v1', { recursive: true });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
    });
  }
}
