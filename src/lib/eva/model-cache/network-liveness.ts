/** A deadline for one pending network operation, not a whole-file deadline.
 * Callers MUST abort the child request/reader in stop(). Never abort a shared
 * package controller for a retryable transport stall.
 */
export const MODEL_NETWORK_HEADER_TIMEOUT_MS = 30_000;
export const MODEL_NETWORK_SILENCE_TIMEOUT_MS = 30_000;

export class ModelNetworkStallError extends Error {
  readonly code = 'NETWORK_STALLED';
  constructor() {
    super('The model request stopped responding. Its durable checkpoint is unchanged.');
    this.name = 'ModelNetworkStallError';
  }
}

export function networkWait<T>(
  operation: () => Promise<T>,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    stop(reason: unknown): void;
    lateResult?(value: T): void;
  },
): Promise<T> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
    return Promise.reject(new RangeError('Network deadline must be positive.'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Reject before stop(): reader.cancel() may settle the pending read.
      reject(reason);
      try { options.stop(reason); } catch { /* preserve the primary failure */ }
    };
    const abort = () => fail(options.signal.reason ?? new DOMException('Cancelled.', 'AbortError'));
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) { abort(); return; }
    timer = setTimeout(() => fail(new ModelNetworkStallError()), options.timeoutMs);
    Promise.resolve().then(() => {
      if (settled) return;
      return operation();
    }).then(value => {
      if (settled) {
        if (value !== undefined) {
          try { options.lateResult?.(value as T); } catch { /* best-effort disposal */ }
        }
        return;
      }
      settled = true;
      cleanup();
      resolve(value as T);
    }, reason => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    });
  });
}

/** Wraps the full-response fallback as well as small-file fetches. Header
 * validation sees the ORIGINAL Response, before its body is wrapped. Returning
 * a new Response loses response.url; it must never be used as origin evidence.
 */
export async function fetchModelResponse(
  fetcher: (signal: AbortSignal) => Promise<Response>,
  parent: AbortSignal,
  validate: (response: Response) => void,
  deadlines: { headerMs?: number; silenceMs?: number } = {},
): Promise<Response> {
  const child = new AbortController();
  const abort = () => child.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  const detach = () => parent.removeEventListener('abort', abort);
  let response: Response;
  try {
    response = await networkWait(() => fetcher(child.signal), {
      signal: parent, timeoutMs: deadlines.headerMs ?? MODEL_NETWORK_HEADER_TIMEOUT_MS,
      stop: reason => child.abort(reason),
      lateResult: late => { void late.body?.cancel().catch(() => undefined); },
    });
    try { validate(response); }
    catch (error) { void response.body?.cancel(error).catch(() => undefined); throw error; }
    if (!response.body) throw new Error('The model response has no stream.');
  } catch (error) { child.abort(error); detach(); throw error; }
  const reader = response.body.getReader();
  let closed = false;
  const finish = (reason?: unknown) => {
    if (closed) return;
    closed = true;
    detach();
    if (reason !== undefined) {
      child.abort(reason);
      void reader.cancel(reason).catch(() => undefined);
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const silenceMs = deadlines.silenceMs ?? MODEL_NETWORK_SILENCE_TIMEOUT_MS;
      const started = performance.now();
      try {
        // This loop ignores zero-byte chunks and does not reset the deadline.
        while (!closed) {
          const part = await networkWait(() => reader.read(), {
            signal: parent, timeoutMs: Math.max(1, silenceMs - (performance.now() - started)),
            stop: reason => finish(reason),
          });
          if (part.done) { finish(); reader.releaseLock(); controller.close(); return; }
          if (part.value.byteLength) { controller.enqueue(part.value); return; }
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          if (performance.now() - started >= silenceMs) throw new ModelNetworkStallError();
        }
      } catch (error) { finish(error); controller.error(error); }
    },
    cancel(reason) { finish(reason ?? new DOMException('Cancelled.', 'AbortError')); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
