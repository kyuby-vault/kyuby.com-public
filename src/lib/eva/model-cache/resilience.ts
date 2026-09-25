import { ModelIntegrityError } from './integrity';
import { WebGpuAdmissionError, WEBGPU_ADMISSION_COPY, type WebGpuAdmissionCode } from '../webgpu-admission';
import type { ModelCacheStorageEstimate } from './types';
import { ModelNetworkStallError } from './network-liveness';

export const ACQUISITION_BACKOFF_MS = [2_000, 5_000, 15_000, 45_000] as const;
export const ACQUISITION_MAX_ATTEMPTS = 4;
export const MOBILE_CHUNK_BYTES = 4 * 1024 * 1024;
export const DESKTOP_CHUNK_BYTES = 8 * 1024 * 1024;
export const MOBILE_CONCURRENCY = 2;
export const MINIMUM_STORAGE_HEADROOM = 256 * 1024 * 1024;

export class AcquisitionNetworkError extends Error {}

export function isAcquisitionNetworkError(error: unknown): boolean {
  return !(error instanceof ModelIntegrityError)
    && (error instanceof AcquisitionNetworkError || error instanceof ModelNetworkStallError);
}

/** Only Fetch/stream-reader failures become retryable, never arbitrary storage TypeErrors. */
export async function acquisitionNetworkOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof TypeError || error instanceof DOMException && error.name === 'NetworkError') {
      throw new AcquisitionNetworkError('The download connection was interrupted.');
    }
    throw error;
  }
}

export function acquisitionBackoff(attempt: number, random = Math.random): number {
  return Math.round(ACQUISITION_BACKOFF_MS[Math.min(Math.max(0, attempt - 1), 3)] * (0.8 + random() * 0.4));
}

export function waitForAcquisitionRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Four chunked attempts TOTAL. The fourth delay precedes the sole whole-file
 * last resort. Each operation reopens the durable manifest-pinned checkpoint.
 * Cancellation, quota and integrity failures never enter this retry loop. */
export async function acquireWithRetry<T>(options: {
  signal: AbortSignal;
  attempt(): Promise<T>;
  fallback(): Promise<T>;
  retrying(attempt: number): void | Promise<void>;
  activity?(): void | Promise<void>;
  wait?: typeof waitForAcquisitionRetry;
  random?: () => number;
}): Promise<T> {
  for (let attempt = 1; attempt <= ACQUISITION_MAX_ATTEMPTS; attempt++) {
    options.signal.throwIfAborted();
    try { return await options.attempt(); }
    catch (error) {
      options.signal.throwIfAborted();
      if (!isAcquisitionNetworkError(error)) throw error;
      await options.retrying(attempt);
      await options.activity?.();
      await (options.wait ?? waitForAcquisitionRetry)(acquisitionBackoff(attempt, options.random), options.signal);
      await options.activity?.();
    }
  }
  options.signal.throwIfAborted();
  return options.fallback();
}

export function acquisitionDevicePolicy(device: {
  userAgentData?: { mobile?: boolean }; deviceMemory?: number;
}, concurrency: 2 | 4 = 2): { mobile: boolean; chunkBytes: number; concurrency: 2 | 4 } {
  // Deliberate conservative heuristic: UA-CH mobile OR <= 4 GiB when reported.
  // Missing signals keep desktop defaults; no UA-string guessing or UI override.
  const mobile = device.userAgentData?.mobile === true
    || (typeof device.deviceMemory === 'number' && device.deviceMemory > 0 && device.deviceMemory <= 4);
  return { mobile, chunkBytes: mobile ? MOBILE_CHUNK_BYTES : DESKTOP_CHUNK_BYTES,
    concurrency: mobile ? MOBILE_CONCURRENCY : concurrency };
}

export type AcquisitionCapacity = 'ok' | 'tight' | 'insufficient';
export function acquisitionCapacity(total: number, cached: number, estimate: ModelCacheStorageEstimate): AcquisitionCapacity {
  const remaining = Math.max(0, total - cached);
  if (!remaining) return 'ok';
  if (estimate.usage === null || estimate.quota === null || !Number.isFinite(estimate.usage)
    || !Number.isFinite(estimate.quota) || estimate.usage < 0 || estimate.quota < 0) return 'tight';
  const headroom = Math.max(Math.ceil(total * 0.1), MINIMUM_STORAGE_HEADROOM);
  const available = Math.max(0, estimate.quota - estimate.usage);
  if (available < remaining + headroom) return 'insufficient';
  return available < remaining + headroom * 2 ? 'tight' : 'ok';
}

export type AcquisitionNoticeCode = 'insufficient-storage' | 'cache-unavailable' | 'connection-lost'
  | 'resuming' | 'verifying' | 'cache-service-restarted' | 'host-contract' | 'load-failed' | WebGpuAdmissionCode;
export const ACQUISITION_NOTICES: Record<AcquisitionNoticeCode, string> = {
  ...WEBGPU_ADMISSION_COPY,
  'insufficient-storage': 'Not enough device storage. Free browser storage or remove an old cached model, then retry. Space for the model plus safety headroom is required.',
  'cache-unavailable': 'Local cache unavailable. A large model requires working browser storage. Your conversation is unchanged; enable site storage and retry.',
  'connection-lost': 'Download interrupted. The connection dropped. Completed download checkpoints are kept; resume continues where it stopped. They remain unverified until the full file passes SHA-256.',
  resuming: 'Resuming download. Continuing from the durable checkpoint on this device; the full file will be verified before use.',
  verifying: 'Verifying download. Checking the downloaded files before first use.',
  'cache-service-restarted': 'The local cache service restarted; continuing.',
  'host-contract': 'Model host contract violation. The model host returned invalid byte-range metadata. Using a verified full-file download; pausing this file restarts it.',
  'load-failed': 'Eva could not load: no model was loaded. Retry — your conversation is intact.',
};

/** The controller displays only this closed vocabulary; raw diagnostics are separate. */
export function acquisitionFailureCode(error: unknown): AcquisitionNoticeCode {
  if (error instanceof WebGpuAdmissionError) return error.code;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'insufficient-storage';
  return isAcquisitionNetworkError(error) ? 'connection-lost' : 'load-failed';
}

export function terminateFailedLoad(runtime: { terminate(): void } | null): null {
  runtime?.terminate();
  return null;
}
