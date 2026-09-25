/** Native SHA-256, one admitted input per realm, honest heartbeat semantics.
 * A Service Worker cannot construct a Worker. Its native WebCrypto path remains
 * explicit; no claim is made that its digest runs in our dedicated worker.
 */
import type { DigestWorkerMessage, DigestWorkerRequest } from '../../../workers/model-digest.worker';

export const MODEL_DIGEST_MODE = 'capability-selected-heartbeat' as const;
export const MODEL_DIGEST_SILENCE_TIMEOUT_MS = 30_000;

export class ModelDigestTimeoutError extends Error {
  readonly code = 'VERIFY_TIMEOUT';
  constructor() {
    super('Local verification timed out; no unverified file was committed.');
    this.name = 'ModelDigestTimeoutError';
  }
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class ModelDigestScheduler {
  lastMode: 'native-webcrypto-heartbeat' | 'dedicated-worker-heartbeat' | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(
    _bytes: number,
    operation: (signal: AbortSignal, touch: () => void) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    return previous.then(async () => {
      const controller = new AbortController();
      let lastLiveness = performance.now();
      const touch = () => { lastLiveness = performance.now(); };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setInterval> | undefined;
      const work = Promise.resolve().then(() => operation(controller.signal, touch));
      // WebCrypto and Blob.arrayBuffer() are not abortable. Do not admit another
      // input merely because the caller's watchdog returned first.
      void work.then(release, release);
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          const fail = () => {
            const error = new ModelDigestTimeoutError();
            controller.abort(error);
            reject(error);
          };
          if (timeoutMs !== undefined) timer = setTimeout(fail, timeoutMs);
          else watchdog = setInterval(() => {
            if (performance.now() - lastLiveness > MODEL_DIGEST_SILENCE_TIMEOUT_MS) fail();
          }, 500);
        })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (watchdog !== undefined) clearInterval(watchdog);
      }
    });
  }

  /** Blob input is lazy: allocation occurs only AFTER queue admission.
   * Legacy callers may still provide a preallocated ArrayBuffer.
   */
  async digestBuffer(
    input: ArrayBuffer | Blob,
    signal?: AbortSignal,
    onProgress?: (hashedBytes: number, totalBytes: number) => void | Promise<void>,
  ): Promise<{ bytes: number; sha256: string }> {
    const size = input instanceof Blob ? input.size : input.byteLength;
    return this.run(size, async (internalSignal, touch) => {
      const check = () => { signal?.throwIfAborted(); internalSignal.throwIfAborted(); };
      check();
      // This indicates a live host event loop, NOT hashing progress. Native
      // async work has no per-byte progress API. A stuck promise remains a
      // cancellation/owner-restart problem, not a guessed MiB/s failure.
      let nativeHeartbeat: ReturnType<typeof setInterval> | undefined = setInterval(touch, 250);
      const stopNativeHeartbeat = () => {
        if (nativeHeartbeat !== undefined) clearInterval(nativeHeartbeat);
        nativeHeartbeat = undefined;
      };
      try {
        const buffer = input instanceof Blob ? await input.arrayBuffer() : input;
        check();
        const byteLength = buffer.byteLength;
        let worker: Worker | null = null;
        if (typeof Worker !== 'undefined') {
          try { worker = new Worker(new URL('../../../workers/model-digest.worker.ts', import.meta.url), { type: 'module' }); }
          catch { /* CSP or worker support failure: keep the explicit native path. */ }
        }
        this.lastMode = worker ? 'dedicated-worker-heartbeat' : 'native-webcrypto-heartbeat';
        if (!worker) {
          const digest = await crypto.subtle.digest('SHA-256', buffer);
          check();
          await onProgress?.(byteLength, byteLength);
          check();
          return { bytes: byteLength, sha256: bufferToHex(digest) };
        }
        stopNativeHeartbeat();
        const activeWorker = worker;
        const id = crypto.randomUUID();
        const result = await new Promise<{ bytes: number; sha256: string }>((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            signal?.removeEventListener('abort', abort);
            internalSignal.removeEventListener('abort', abort);
            activeWorker.onmessage = null;
            activeWorker.onerror = null;
            activeWorker.onmessageerror = null;
            activeWorker.terminate();
          };
          const fail = (reason: unknown) => { if (!settled) { settled = true; cleanup(); reject(reason); } };
          const abort = () => fail(signal?.reason ?? internalSignal.reason ?? new DOMException('Cancelled.', 'AbortError'));
          activeWorker.onmessage = (event: MessageEvent<DigestWorkerMessage>) => {
            const msg = event.data;
            if (!msg || msg.id !== id) return;
            if (msg.type === 'heartbeat') { touch(); return; } // Never report unverified bytes.
            if (msg.type === 'error') { fail(new Error('The digest worker failed.')); return; }
            if (msg.type !== 'result' || msg.bytes !== byteLength || !/^[a-f0-9]{64}$/.test(msg.sha256)) {
              fail(new Error('Invalid digest worker response.')); return;
            }
            if (settled) return;
            settled = true;
            touch(); cleanup();
            resolve({ bytes: msg.bytes, sha256: msg.sha256 });
          };
          activeWorker.onerror = () => fail(new Error('The digest worker failed.'));
          activeWorker.onmessageerror = () => fail(new Error('The digest worker response could not be decoded.'));
          signal?.addEventListener('abort', abort, { once: true });
          internalSignal.addEventListener('abort', abort, { once: true });
          try {
            check();
            activeWorker.postMessage({ id, buffer } satisfies DigestWorkerRequest, [buffer]);
          } catch (error) { fail(error); }
        });
        check();
        await onProgress?.(result.bytes, result.bytes);
        check();
        return result;
      } finally { stopNativeHeartbeat(); }
    });
  }
}
