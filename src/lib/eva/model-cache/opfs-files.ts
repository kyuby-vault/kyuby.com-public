import { hashBytes } from './integrity';

// A native asynchronous equivalent to opfs-tools, deliberately without its
// inline Blob workers. No model-sized ArrayBuffer or worker IPC is introduced.
export type OpfsDirectory = FileSystemDirectoryHandle;

interface MovableFile extends FileSystemFileHandle {
  move(name: string): Promise<void>;
}

export async function opfsOpaqueName(value: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(value));
}

export function modelIdForCacheRoot(modelRootPath: string): string {
  const id = modelRootPath.replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw new Error('The model ID is not a safe OPFS directory name.');
  }
  return id;
}

export async function opfsPackagePath(packageKey: string): Promise<string> {
  const tuple: unknown = JSON.parse(packageKey);
  if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every((value) => typeof value === 'string')) {
    throw new Error('Invalid model package identity.');
  }
  // The version includes origin and full root as well as the manifest identity:
  // development and production cannot collide even for an identical model ID.
  return `${modelIdForCacheRoot(tuple[1])}/${await opfsOpaqueName(packageKey)}`;
}

export async function opfsDirectory(
  root: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<OpfsDirectory> {
  let directory = root;
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error('Unsafe OPFS path.');
    }
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return directory as OpfsDirectory;
}

export function isMissingOpfsEntry(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export async function removeOpfsFile(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  await directory.removeEntry(name).catch((error: unknown) => {
    if (!isMissingOpfsEntry(error)) throw error;
  });
}

export async function writeOpfsStream(
  handle: FileSystemFileHandle,
  source: Blob | ReadableStream<Uint8Array>,
): Promise<void> {
  const writable = await handle.createWritable({ keepExistingData: false });
  const reader = (source instanceof Blob ? source.stream() : source).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      await writable.write(copy.buffer);
    }
    await writable.close();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await writable.abort(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function promoteOpfsFile(handle: FileSystemFileHandle, finalName: string): Promise<void> {
  if (typeof (handle as Partial<MovableFile>).move !== 'function') {
    throw new Error('Safe atomic OPFS promotion is unavailable.');
  }
  // move() replaces an existing destination atomically; never delete it first.
  await (handle as MovableFile).move(finalName);
}

export async function openOpfsModelRoot(): Promise<OpfsDirectory> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error('OPFS is unavailable. Model loading remains network-only.');
  }
  const originRoot = await navigator.storage.getDirectory();
  const root = await opfsDirectory(originRoot, 'eva-model-cache/v1', true);
  const temporary = `.probe-${crypto.randomUUID()}`;
  const destination = `.probe-${crypto.randomUUID()}`;
  try {
    const handle = await root.getFileHandle(temporary, { create: true });
    await root.getFileHandle(destination, { create: true });
    await promoteOpfsFile(handle, destination);
    await root.getFileHandle(destination);
    return root;
  } finally {
    await removeOpfsFile(root, temporary).catch(() => undefined);
    await removeOpfsFile(root, destination).catch(() => undefined);
  }
}
