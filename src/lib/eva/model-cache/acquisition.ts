import { ModelIntegrityError } from './integrity';
import { AcquisitionNetworkError, acquisitionNetworkOperation, DESKTOP_CHUNK_BYTES } from './resilience';
import { networkWait, ModelNetworkStallError, MODEL_NETWORK_HEADER_TIMEOUT_MS, MODEL_NETWORK_SILENCE_TIMEOUT_MS } from './network-liveness';

export class RangeUnavailableError extends Error {}

export class ModelSourceUnavailableError extends Error {
  readonly code = 'MODEL_SOURCE_UNAVAILABLE';
  constructor() { super('The model source is unavailable or authorization has expired. Saved files are unchanged.'); }
}
export class ModelRangeResetRequiredError extends Error {
  readonly code = 'RANGE_REVALIDATION_REQUIRED';
  constructor() { super('The model source rejected the saved range. Recheck its manifest before retrying.'); }
}

export function validateAcquisitionRange(response: Response, start: number, end: number, total: number): void {
  if (response.status >= 500 && response.status <= 599) throw new AcquisitionNetworkError('Range service temporarily unavailable.');
  if ([401, 403, 404, 410].includes(response.status)) throw new ModelSourceUnavailableError();
  if (response.status === 416) throw new ModelRangeResetRequiredError();
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
  fetch(start: number, end: number, signal: AbortSignal): Promise<Response>;
  checkpoint(offset: number): Promise<void>;
  progress(received: number, durable: number): void | Promise<void>;
  chunkBytes?: number;
  headerTimeoutMs?: number;
  silenceTimeoutMs?: number;
}): Promise<void> {
  const chunkBytes = options.chunkBytes ?? Math.min(DESKTOP_CHUNK_BYTES, Math.max(16 * 1024, Math.ceil(options.total / 8)));
  if (!Number.isSafeInteger(options.total) || options.total < 0 || !Number.isSafeInteger(offset)
    || offset < 0 || offset > options.total || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Invalid download checkpoint.');
  await options.progress(offset, offset);
  while (offset < options.total) {
    options.signal.throwIfAborted();
    const end = Math.min(options.total, offset + chunkBytes) - 1;
    const request = new AbortController();
    const cancelRequest = () => request.abort(options.signal.reason);
    options.signal.addEventListener('abort', cancelRequest, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let writer: FileSystemWritableFileStream | undefined;
    let received = offset;
    const stop = (reason: unknown) => {
      request.abort(reason);
      void reader?.cancel(reason).catch(() => undefined);
    };
    try {
      const response = await acquisitionNetworkOperation(() => networkWait(
        () => options.fetch(offset, end, request.signal), {
          signal: options.signal, timeoutMs: options.headerTimeoutMs ?? MODEL_NETWORK_HEADER_TIMEOUT_MS,
          stop, lateResult: late => { void late.body?.cancel().catch(() => undefined); },
        },
      ));
      try { validateAcquisitionRange(response, offset, end, options.total); }
      catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
      if (!response.body) throw new AcquisitionNetworkError('Range response has no body.');
      reader = response.body.getReader();
      writer = await handle.createWritable({ keepExistingData: true });
      await writer.truncate(offset);
      await writer.seek(offset);
      const silenceMs = options.silenceTimeoutMs ?? MODEL_NETWORK_SILENCE_TIMEOUT_MS;
      let emptyReadMs = 0;
      while (true) {
        options.signal.throwIfAborted();
        const started = performance.now();
        const part = await acquisitionNetworkOperation(() => networkWait(() => reader!.read(), {
          signal: options.signal, timeoutMs: Math.max(1, silenceMs - emptyReadMs), stop,
        }));
        if (part.done) break;
        if (!part.value.byteLength) {
          // Empty chunks are not progress. Yield so a malicious empty stream
          // cannot starve cancellation and the silence timer via microtasks.
          emptyReadMs += Math.max(1, performance.now() - started);
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          if (emptyReadMs >= silenceMs) {
            throw new ModelNetworkStallError();
          }
          continue;
        }
        emptyReadMs = 0;
        received += part.value.byteLength;
        if (received > end + 1) throw new ModelIntegrityError('LENGTH_MISMATCH', 'Range body exceeded its declared chunk length.');
        await writer.write(new Uint8Array(part.value).buffer);
        await options.progress(received, offset);
      }
      if (received !== end + 1) throw new AcquisitionNetworkError('Range body ended before its declared chunk length.');
      options.signal.throwIfAborted();
      await writer.close();
      writer = undefined;
      // Crash after close and before checkpoint re-downloads at most this
      // chunk. Only the checkpoint is a durable resume authorization.
      await options.checkpoint(received);
      offset = received;
      await options.progress(received, offset);
    } catch (error) {
      stop(error);
      await writer?.abort(error).catch(() => undefined);
      throw error;
    } finally {
      options.signal.removeEventListener('abort', cancelRequest);
      reader?.releaseLock();
    }
  }
}
