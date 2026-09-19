import { ModelIntegrityError } from './integrity';
import { AcquisitionNetworkError, acquisitionNetworkOperation, DESKTOP_CHUNK_BYTES } from './resilience';

export class RangeUnavailableError extends Error {}

export function validateAcquisitionRange(response: Response, start: number, end: number, total: number): void {
  if (response.status >= 500 && response.status <= 599) throw new AcquisitionNetworkError('Range service temporarily unavailable.');
  const expected = `bytes ${start}-${end}/${total}`;
  if (response.status !== 206 || response.headers.get('Content-Range') !== expected
    || (response.headers.has('Content-Length') && response.headers.get('Content-Length') !== String(end - start + 1))
    || (response.headers.has('Content-Encoding') && response.headers.get('Content-Encoding') !== 'identity')) {
    throw new RangeUnavailableError(`Range unavailable: expected ${expected}; received ${response.status} ${response.headers.get('Content-Range') ?? '(missing)'}.`);
  }
}

/** Closed OPFS writes are durable prefixes, never complete artifacts. Final SHA validation is owned by the backend. */
export async function acquireModelChunks(handle: FileSystemFileHandle, offset: number, options: {
  total: number;
  signal: AbortSignal;
  fetch(start: number, end: number): Promise<Response>;
  checkpoint(offset: number): Promise<void>;
  progress(received: number, durable: number): void | Promise<void>;
  chunkBytes?: number;
}): Promise<void> {
  const chunkBytes = options.chunkBytes ?? Math.min(DESKTOP_CHUNK_BYTES, Math.max(16 * 1024, Math.ceil(options.total / 8)));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > options.total || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Invalid download checkpoint.');
  await options.progress(offset, offset);
  while (offset < options.total) {
    options.signal.throwIfAborted();
    const end = Math.min(options.total, offset + chunkBytes) - 1;
    const response = await acquisitionNetworkOperation(() => options.fetch(offset, end));
    try { validateAcquisitionRange(response, offset, end, options.total); }
    catch (error) { await response.body?.cancel().catch(() => undefined); throw error; }
    if (!response.body) throw new AcquisitionNetworkError('Range response has no body.');
    const reader = response.body.getReader();
    let writer: FileSystemWritableFileStream | undefined;
    let received = offset;
    try {
      writer = await handle.createWritable({ keepExistingData: true });
      await writer.truncate(offset);
      await writer.seek(offset);
      while (true) {
        options.signal.throwIfAborted();
        const part = await acquisitionNetworkOperation(() => reader.read());
        if (part.done) break;
        received += part.value.byteLength;
        if (received > end + 1) throw new ModelIntegrityError('LENGTH_MISMATCH', 'Range body exceeded its declared chunk length.');
        await writer.write(new Uint8Array(part.value).buffer);
        await options.progress(received, offset);
      }
      // An interrupted chunk is transport loss, not a completed-file hash failure.
      // Abort the write; never checkpoint it. Oversize bodies and final SHA fail closed.
      if (received !== end + 1) throw new AcquisitionNetworkError('Range body ended before its declared chunk length.');
      options.signal.throwIfAborted();
      await writer.close();
      await options.checkpoint(received);
      offset = received;
      await options.progress(received, offset);
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      await writer?.abort(error).catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
  }
}
