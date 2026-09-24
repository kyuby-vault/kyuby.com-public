/**
 * src/lib/eva/model-cache/digest-scheduler.ts
 * Manages SHA-256 digest scheduling with heartbeat liveness.
 * Bounded by worker silence > 30s or worker death rather than an assumed MiB/s.
 */

import type { DigestWorkerMessage, DigestWorkerRequest } from '../../../workers/model-digest.worker';

export const MODEL_DIGEST_MODE = 'dedicated-worker-heartbeat' as const;
export const MODEL_DIGEST_SILENCE_TIMEOUT_MS = 30_000;

export class ModelDigestTimeoutError extends Error {
  readonly code = 'VERIFY_TIMEOUT';
  constructor() {
    super('Local verification timed out; no unverified file was committed.');
    this.name = 'ModelDigestTimeoutError';
  }
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * One bounded hashing job per scope, independent of transfer concurrency.
 * Monitored by worker heartbeat liveness: fails only on silence > 30s or worker death.
 */
export class ModelDigestScheduler {
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * Run an arbitrary digest or verification operation with heartbeat liveness monitoring.
   */
  run<T>(
    _bytes: number,
    operation: (signal: AbortSignal, touch: () => void) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const result = this.#tail.then(async () => {
      const controller = new AbortController();
      let lastLiveness = Date.now();
      const touch = () => {
        lastLiveness = Date.now();
      };

      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        return await Promise.race([
          operation(controller.signal, touch),
          new Promise<never>((_resolve, reject) => {
            if (timeoutMs !== undefined) {
              const directTimer = setTimeout(() => {
                const error = new ModelDigestTimeoutError();
                controller.abort(error);
                reject(error);
              }, timeoutMs);
              controller.signal.addEventListener('abort', () => clearTimeout(directTimer), { once: true });
            } else {
              timer = setInterval(() => {
                if (Date.now() - lastLiveness > MODEL_DIGEST_SILENCE_TIMEOUT_MS) {
                  clearInterval(timer);
                  const error = new ModelDigestTimeoutError();
                  controller.abort(error);
                  reject(error);
                }
              }, 500);
            }
          }),
        ]);
      } finally {
        if (timer !== undefined) clearInterval(timer);
      }
    });

    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Digest a whole ArrayBuffer using the dedicated digest worker when available,
   * falling back to crypto.subtle in ServiceWorkerGlobalScope where Worker is unavailable.
   */
  async digestBuffer(
    buffer: ArrayBuffer,
    signal?: AbortSignal,
    onProgress?: (hashedBytes: number, totalBytes: number) => void | Promise<void>,
  ): Promise<{ bytes: number; sha256: string }> {
    return this.run(buffer.byteLength, async (internalSignal, touch) => {
      if (signal?.aborted) throw signal.reason;

      const combinedAbort = () => {
        if (signal?.aborted) throw signal.reason;
        internalSignal.throwIfAborted();
      };

      const byteLength = buffer.byteLength;
      const id = `digest-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // Dedicated Worker path (when Worker constructor is exposed, e.g. Window or DedicatedWorker)
      if (typeof Worker !== 'undefined') {
        return new Promise<{ bytes: number; sha256: string }>((resolve, reject) => {
          let worker: Worker | null = null;
          try {
            worker = new Worker(
              new URL('../../../workers/model-digest.worker.ts', import.meta.url),
              { type: 'module' },
            );
          } catch {
            // If worker instantiation fails (e.g. strict CSP or environment limitation), fall through to crypto.subtle
            worker = null;
          }

          if (!worker) {
            combinedAbort();
            touch();
            crypto.subtle.digest('SHA-256', buffer).then(
              digest => {
                touch();
                void onProgress?.(byteLength, byteLength);
                resolve({ bytes: byteLength, sha256: bufferToHex(digest) });
              },
              reject,
            );
            return;
          }

          const cleanup = () => {
            if (worker) {
              worker.onmessage = null;
              worker.onerror = null;
              worker.terminate();
              worker = null;
            }
          };

          const onAbort = () => {
            cleanup();
            reject(signal?.reason || internalSignal.reason);
          };

          signal?.addEventListener('abort', onAbort, { once: true });
          internalSignal.addEventListener('abort', onAbort, { once: true });

          worker.onmessage = (event: MessageEvent<DigestWorkerMessage>) => {
            const msg = event.data;
            if (msg.id !== id) return;

            touch();
            if (msg.type === 'heartbeat') {
              void onProgress?.(msg.bytesProcessed, byteLength);
            } else if (msg.type === 'result') {
              cleanup();
              void onProgress?.(msg.bytes, byteLength);
              resolve({ bytes: msg.bytes, sha256: msg.sha256 });
            } else if (msg.type === 'error') {
              cleanup();
              reject(new Error(msg.error));
            }
          };

          worker.onerror = (err) => {
            cleanup();
            reject(new Error(`Digest worker error: ${err.message || 'Worker terminated unexpectedly'}`));
          };

          const request: DigestWorkerRequest = { id, buffer };
          worker.postMessage(request, [buffer]);
        });
      }

      // Fallback for ServiceWorkerGlobalScope where typeof Worker === 'undefined'
      combinedAbort();
      touch();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      touch();
      void onProgress?.(byteLength, byteLength);
      return { bytes: byteLength, sha256: bufferToHex(digest) };
    });
  }
}
