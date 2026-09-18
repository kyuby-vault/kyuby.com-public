import { hashBytes } from './integrity';
import {
  isMissingOpfsEntry, opfsDirectory, opfsOpaqueName, opfsPackagePath,
  promoteOpfsFile, removeOpfsFile, writeOpfsStream, type OpfsDirectory,
} from './opfs-files';
import {
  createModelCachePackageKey,
  type ModelCacheFileRecord, type ModelCacheManifestRecord,
  type ModelCacheMetadataRepository, type ModelCachePackageRecord, type ModelCacheTemporaryRecord,
} from './store';

type RecordKind = 'package' | 'file' | 'manifest' | 'temporary';
type MetadataRecord = ModelCachePackageRecord | ModelCacheFileRecord | ModelCacheManifestRecord | ModelCacheTemporaryRecord;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;

function packageKey(record: MetadataRecord): string {
  if ('packageKey' in record) return record.packageKey;
  return createModelCachePackageKey(record.modelOrigin, record.modelRootPath, record.manifestVersion);
}

// One atomic JSON object per record, stored with its model/version. Independent
// records never rewrite a shared index, so parallel model partitions do not
// overwrite each other's metadata. Metadata and weights have the same owner.
export class OpfsModelCacheRepository implements ModelCacheMetadataRepository {
  constructor(readonly root: OpfsDirectory) {}

  async #write(kind: RecordKind, record: MetadataRecord): Promise<void> {
    const directory = await opfsDirectory(this.root, `${await opfsPackagePath(packageKey(record))}/_metadata`, true);
    const key = 'id' in record ? record.id : record.key;
    const name = `${kind}-${await opfsOpaqueName(key)}.json`;
    const temporary = `.tmp-${crypto.randomUUID()}`;
    const payload = JSON.stringify('rawBytes' in record ? { ...record, rawBytes: Array.from(record.rawBytes) } : record);
    const encoded = new TextEncoder().encode(payload);
    if (encoded.byteLength > MAX_METADATA_BYTES) throw new Error('Model metadata exceeds its size limit.');
    const body = new Blob([JSON.stringify({ schemaVersion: 1, kind, sha256: await hashBytes(encoded), payload })]);
    const handle = await directory.getFileHandle(temporary, { create: true });
    try {
      await writeOpfsStream(handle, body);
      await promoteOpfsFile(handle, name);
    } finally {
      await removeOpfsFile(directory, temporary).catch(() => undefined);
    }
  }

  async #entries(kind: RecordKind): Promise<Array<{ record: MetadataRecord; directory: OpfsDirectory; name: string }>> {
    const entries: Array<{ record: MetadataRecord; directory: OpfsDirectory; name: string }> = [];
    for await (const [modelId, modelHandle] of this.root.entries()) {
      // Old flat, opaque package directories are preserved, never mistaken for
      // the new partitioned layout or automatically reclaimed during migration.
      if (modelHandle.kind !== 'directory' || /^[a-f0-9]{64}$/.test(modelId)) continue;
      for await (const [version, versionHandle] of (modelHandle as OpfsDirectory).entries()) {
        if (versionHandle.kind !== 'directory' || !/^[a-f0-9]{64}$/.test(version)) continue;
        let directory: OpfsDirectory;
        try {
          directory = await opfsDirectory(versionHandle as FileSystemDirectoryHandle, '_metadata');
        } catch (error) {
          if (isMissingOpfsEntry(error)) continue;
          throw error;
        }
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind !== 'file' || !name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
          try {
            const file = await (handle as FileSystemFileHandle).getFile();
            if (file.size > MAX_METADATA_BYTES * 2) throw new Error('Oversized model metadata.');
            const envelope = JSON.parse(await file.text());
            if (envelope.schemaVersion !== 1 || envelope.kind !== kind || typeof envelope.payload !== 'string'
              || await hashBytes(new TextEncoder().encode(envelope.payload)) !== envelope.sha256) {
              throw new Error('Corrupt model metadata.');
            }
            const record = JSON.parse(envelope.payload) as MetadataRecord;
            const key = 'id' in record ? record.id : record.key;
            if (await opfsPackagePath(packageKey(record)) !== `${modelId}/${version}`
              || name !== `${kind}-${await opfsOpaqueName(key)}.json`) throw new Error('Mismatched model metadata.');
            if ('rawBytes' in record) record.rawBytes = new Uint8Array(record.rawBytes);
            entries.push({ record, directory, name });
          } catch {
            // Never use malformed metadata as proof of a complete model. Keep
            // bytes untouched so an explicit removal/recovery can inspect them.
          }
        }
      }
    }
    return entries;
  }

  async #list<T extends MetadataRecord>(kind: RecordKind): Promise<T[]> {
    return (await this.#entries(kind)).map(({ record }) => record as T);
  }

  async #delete(kind: RecordKind, key: string): Promise<void> {
    for (const entry of await this.#entries(kind)) {
      if (('id' in entry.record ? entry.record.id : entry.record.key) === key) {
        await removeOpfsFile(entry.directory, entry.name);
      }
    }
  }

  async getPackage(key: string) { return (await this.listPackages()).find((record) => record.key === key); }
  putPackage(record: ModelCachePackageRecord) { return this.#write('package', record); }
  listPackages() { return this.#list<ModelCachePackageRecord>('package'); }
  deletePackage(key: string) { return this.#delete('package', key); }
  async getFile(key: string) { return (await this.listFiles()).find((record) => record.key === key); }
  putFile(record: ModelCacheFileRecord) { return this.#write('file', record); }
  async listFiles(packageKey?: string) {
    return (await this.#list<ModelCacheFileRecord>('file')).filter((record) => packageKey === undefined || record.packageKey === packageKey);
  }
  deleteFile(key: string) { return this.#delete('file', key); }
  async getManifest(key: string) {
    return (await this.listManifests()).filter((record) => record.key === key).sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
  }
  putManifest(record: ModelCacheManifestRecord) { return this.#write('manifest', record); }
  listManifests() { return this.#list<ModelCacheManifestRecord>('manifest'); }
  deleteManifest(key: string) { return this.#delete('manifest', key); }
  listTemporary() { return this.#list<ModelCacheTemporaryRecord>('temporary'); }
  putTemporary(record: ModelCacheTemporaryRecord) { return this.#write('temporary', record); }
  deleteTemporary(id: string) { return this.#delete('temporary', id); }
  close(): void { /* No IDB connection, worker, or process-global model state. */ }
}
