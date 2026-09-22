export const MODEL_DIGEST_MODE = 'yielded-service-worker' as const;
export const MODEL_DIGEST_MIN_TIMEOUT_MS = 30_000;
export const MODEL_DIGEST_EXPECTED_BYTES_PER_SECOND = 4 * 1024 * 1024;

export class ModelDigestTimeoutError extends Error {
  readonly code = 'VERIFY_TIMEOUT';
  constructor() { super('Local verification timed out; no unverified file was committed.'); }
}

/** One bounded hashing job per SW global, independent of transfer concurrency.
 * The fallback reads snapshots only. A timed-out job is signalled before the
 * queue advances; callers must check that signal after every awaited read. */
export class ModelDigestScheduler {
  #tail: Promise<void> = Promise.resolve();

  run<T>(bytes: number, operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs = Math.max(MODEL_DIGEST_MIN_TIMEOUT_MS,
      2 * (5_000 + Math.ceil(bytes / MODEL_DIGEST_EXPECTED_BYTES_PER_SECOND * 1_000)))): Promise<T> {
    const result = this.#tail.then(async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(controller.signal),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const error = new ModelDigestTimeoutError(); controller.abort(error); reject(error);
            }, timeoutMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
