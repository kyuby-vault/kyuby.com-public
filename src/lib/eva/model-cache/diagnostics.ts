import { isCanonicalModelCacheFilePath } from './routing';
import type { ModelCacheWorkerMessage } from './protocol';

export const ACQUISITION_DIAGNOSTIC_MAX_EVENTS = 500;
export const ACQUISITION_DIAGNOSTIC_MAX_BYTES = 256 * 1024;
// Split the allowance so a SW snapshot + one page never exceeds the total cap.
export const DIAGNOSTIC_LIMITS = { sw: { events: 400, bytes: 192 * 1024 }, page: { events: 100, bytes: 64 * 1024 } };
const encoder = new TextEncoder();
const kinds = new Set(['phase', 'retry', 'range', 'range-response', 'full-fetch', 'heartbeat-ack',
  'lease', 'error', 'preflight', 'wake-lock', 'package-complete']);
const numbers = new Set(['start', 'end', 'total', 'received', 'verified', 'attempt', 'status', 'gapMs', 'elapsedMs', 'usage', 'quota']);
const labels = new Set(['code', 'phase', 'transport']);

export interface AcquisitionDiagnosticEvent {
  at: number;
  source: 'sw' | 'page';
  kind: string;
  file?: string;
  lease?: string; // Short correlation only, NEVER an authorizing nonce.
  code?: string;
  phase?: string;
  transport?: string;
  start?: number;
  end?: number;
  total?: number;
  received?: number;
  verified?: number;
  attempt?: number;
  status?: number;
  gapMs?: number;
  elapsedMs?: number;
  usage?: number;
  quota?: number;
}
export interface AcquisitionDiagnosticSnapshot {
  startedAt: number;
  dropped: number;
  events: AcquisitionDiagnosticEvent[];
}

export function isAcquisitionDiagnosticEvent(value: unknown): value is AcquisitionDiagnosticEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!Number.isSafeInteger(event.at) || (event.at as number) < 0
    || !['sw', 'page'].includes(String(event.source)) || !kinds.has(String(event.kind))) return false;
  return Object.entries(event).every(([key, field]) => {
    if (['at', 'source', 'kind'].includes(key)) return true;
    if (numbers.has(key)) return typeof field === 'number' && Number.isFinite(field) && field >= 0 && field <= Number.MAX_SAFE_INTEGER;
    if (labels.has(key)) return typeof field === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(field);
    if (key === 'lease') return typeof field === 'string' && /^[A-Za-z0-9_-]{1,8}$/.test(field);
    if (key === 'file') return typeof field === 'string' && field.length <= 512 && isCanonicalModelCacheFilePath(field);
    return false; // No free-form text, URLs, payloads, headers or secret-bearing extensions.
  });
}

export function isAcquisitionDiagnosticSnapshot(value: unknown, source: 'sw' | 'page'): value is AcquisitionDiagnosticSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as AcquisitionDiagnosticSnapshot;
  return Object.keys(snapshot).sort().join(',') === 'dropped,events,startedAt'
    && Number.isSafeInteger(snapshot.startedAt) && snapshot.startedAt >= 0
    && Number.isSafeInteger(snapshot.dropped) && snapshot.dropped >= 0
    && Array.isArray(snapshot.events) && snapshot.events.length <= DIAGNOSTIC_LIMITS[source].events
    && snapshot.events.every(event => isAcquisitionDiagnosticEvent(event) && event.source === source)
    && encoder.encode(JSON.stringify(snapshot.events)).byteLength <= DIAGNOSTIC_LIMITS[source].bytes;
}

/** Bounded, process-local history. No timers, storage, network, console or side effects on acquisition. */
export class AcquisitionDiagnostics {
  readonly startedAt: number;
  #events: Array<{ json: string; bytes: number }> = [];
  #bytes = 2; // JSON array brackets, plus a conservative comma per event below.
  #dropped = 0;
  #phases = new Map<string, string>();
  constructor(readonly source: 'sw' | 'page', readonly now = Date.now) { this.startedAt = now(); }

  record(input: Omit<AcquisitionDiagnosticEvent, 'at' | 'source'>): void {
    const event = { ...input, at: this.now(), source: this.source };
    if (!isAcquisitionDiagnosticEvent(event)) return;
    const json = JSON.stringify(event);
    const bytes = encoder.encode(json).byteLength + 1;
    const limit = DIAGNOSTIC_LIMITS[this.source];
    if (bytes > limit.bytes - 2) { this.#dropped++; return; }
    this.#events.push({ json, bytes }); this.#bytes += bytes;
    while (this.#events.length > limit.events || this.#bytes > limit.bytes) {
      this.#bytes -= this.#events.shift()!.bytes; this.#dropped++;
    }
  }

  observe(message: ModelCacheWorkerMessage): void {
    if (message.type === 'FILE_PROGRESS') {
      const key = `${message.modelRootPath}:${message.file}`;
      const phase = `${message.source}:${message.phase}:${message.attempt ?? ''}`;
      if (this.#phases.get(key) === phase) return;
      this.#phases.delete(key); this.#phases.set(key, phase);
      if (this.#phases.size > 128) this.#phases.delete(this.#phases.keys().next().value!);
      this.record({ kind: message.phase === 'retrying' ? 'retry' : 'phase', file: message.file,
        phase: message.phase, transport: message.source, received: message.receivedBytes, verified: message.verifiedBytes,
        total: message.totalBytes, ...(message.attempt === undefined ? {} : { attempt: message.attempt, code: 'connection-lost' }) });
    } else if (message.type === 'CACHE_WARNING' || message.type === 'ERROR') {
      this.record({ kind: 'error', code: message.type === 'ERROR' ? message.code : message.warning.code });
    } else if (message.type === 'PACKAGE_COMPLETE') {
      this.record({ kind: 'package-complete', lease: message.nonce.slice(0, 8) });
    }
  }

  snapshot(): AcquisitionDiagnosticSnapshot {
    return { startedAt: this.startedAt, dropped: this.#dropped, events: this.#events.map(({ json }) => JSON.parse(json)) };
  }
}

/** Only reviewed classifications, never Error.message/stack or arbitrary .code values. */
export function acquisitionDiagnosticError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (typeof code === 'string' && ['RPC_TIMEOUT', 'NOT_CONFIGURED', 'LEASE_REJECTED', 'CACHE_FAILED',
    'HASH_MISMATCH', 'LENGTH_MISMATCH', 'VERIFY_TIMEOUT', 'REMOVE_FAILED',
    'NETWORK_STALLED', 'MODEL_SOURCE_UNAVAILABLE', 'RANGE_REVALIDATION_REQUIRED', 'MODEL_STREAM_REQUIRED'].includes(code)) return code;
  if (error instanceof Error && ['AbortError', 'QuotaExceededError', 'NetworkError', 'TypeError'].includes(error.name)) return error.name;
  return 'load-failed';
}

export function acquisitionDiagnosticsJson(sw: AcquisitionDiagnosticSnapshot | null, page: AcquisitionDiagnosticSnapshot,
  state: Record<string, unknown>): string {
  const events = [...(sw?.events ?? []), ...page.events].sort((a, b) => a.at - b.at);
  const output = { schemaVersion: 1, capturedAt: Date.now(),
    scope: 'Local memory only; SW history is shared across tabs and resets when the service restarts. No chat or raw errors.',
    heartbeatGapMeaning: 'SW gapMs is time between handled renew acknowledgements, not network RTT. Page elapsedMs is RPC round-trip time.',
    swStartedAt: sw?.startedAt ?? null, pageStartedAt: page.startedAt,
    dropped: (sw?.dropped ?? 0) + page.dropped, state, events };
  // Include state/envelope in the clipboard byte cap too, even at maximum retention.
  let json = JSON.stringify(output);
  while (encoder.encode(json).byteLength > ACQUISITION_DIAGNOSTIC_MAX_BYTES && events.length) {
    events.shift(); output.dropped++; json = JSON.stringify(output);
  }
  if (encoder.encode(json).byteLength > ACQUISITION_DIAGNOSTIC_MAX_BYTES) throw new Error('Diagnostic state exceeds the local copy limit.');
  return json;
}

/** Invoke immediately in the click handler: promise-backed ClipboardItem preserves mobile user activation. */
export async function copyAcquisitionDiagnostics(snapshot: () => Promise<string>): Promise<void> {
  if (!navigator.clipboard) throw new Error('Clipboard unavailable.');
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    const text = snapshot().then(json => new Blob([json], { type: 'text/plain' }));
    void text.catch(() => undefined); // A denied write may reject before the snapshot settles.
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
  } else {
    await navigator.clipboard.writeText(await snapshot());
  }
}
