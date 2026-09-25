/** Temporary, opt-in diagnostics. Reuses EvaModelCacheClient.diagnostics.
 * No fetch interception, console interception, content, tokens, URLs, or storage
 * of logs. Export only from an explicit user action. No automatic model load.
 */
import { requireWebGpu } from './webgpu-admission';

interface DiagnosticSink {
  record(event: { kind: string; code?: string; total?: number; received?: number;
    verified?: number; attempt?: number; status?: number; elapsedMs?: number; usage?: number; quota?: number }): void;
}
const CODES = new Set([
  'worker-created', 'worker-terminated', 'worker-message-error', 'gpu-device-lost',
  'gpu-device-destroyed', 'gpu-out-of-memory', 'gpu-validation-error', 'gpu-error',
  'shader-compilation', 'buffer-high-water', 'model-init-start', 'model-init-complete',
  'model-init-failed', 'checkpoint', 'network-stalled', 'range-response',
  'range-invalid', 'integrity-passed', 'integrity-failed', 'idb-transaction-failed',
  'page-visible', 'page-hidden', 'page-show', 'page-hide', 'page-freeze', 'page-resume',
  'network-online', 'network-offline', 'sw-controller-change', 'probe-gpu-pass',
  'probe-gpu-fail', 'probe-opfs-pass', 'probe-opfs-fail', 'probe-idb-pass', 'probe-idb-fail',
]);
const NUMERIC = new Set(['total', 'received', 'verified', 'attempt', 'status', 'elapsedMs', 'usage', 'quota']);
const MAX_EXPORT_BYTES = 256 * 1024;
const MAX_EVENTS = 500;
const encoder = new TextEncoder();

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}
function safeError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return ['AbortError', 'QuotaExceededError', 'SecurityError', 'NotFoundError', 'InvalidStateError',
    'NotAllowedError', 'NotSupportedError', 'TypeError'].includes(name) ? name : 'operation-failed';
}
function safeLimits(value: object | undefined): Record<string, number | null> {
  return Object.fromEntries(['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupSizeX',
    'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupStorageSize'].map(key => [key, safeNumber((value as Record<string, unknown> | undefined)?.[key])]));
}

/** UA reduction is deliberate: no device identifiers or arbitrary UA text. */
export function normalizedAgent(ua: string): { browser: string; android: string | null; mobile: boolean } {
  const product = /(EdgA?)\/([0-9.]{1,32})(?:\s|$)/.exec(ua)
    ?? /(Chrome|Firefox|Version)\/([0-9.]{1,32})(?:\s|$)/.exec(ua);
  return { browser: product ? `${product[1]}/${product[2]}` : 'unknown',
    android: /Android ([0-9.]{1,24})(?:[; )]|$)/.exec(ua)?.[1] ?? null, mobile: /\bMobile\b/.test(ua) };
}

export class RuntimeDiagnostics {
  #stopped = false;
  #cleanup: Array<() => void> = [];
  #metadata: Record<string, unknown> = { schemaVersion: 1, runtimeGpuObserved: false,
    wasmThreadsTested: false, modelPeakMemoryMeasured: false };
  #peakBuffer = 0;
  constructor(private sink: DiagnosticSink) {}

  event(code: string, fields: Record<string, unknown> = {}): void {
    if (this.#stopped || !CODES.has(code)) return;
    const safe: Record<string, number> = {};
    for (const [key, value] of Object.entries(fields)) {
      const number = safeNumber(value);
      if (NUMERIC.has(key) && number !== null) safe[key] = number;
    }
    this.sink.record({ kind: 'preflight', code, ...safe });
  }

  startLifecycle(): void {
    if (this.#stopped || typeof document === 'undefined' || this.#cleanup.length) return;
    const add = (target: EventTarget, name: string, fn: () => void) => {
      target.addEventListener(name, fn); this.#cleanup.push(() => target.removeEventListener(name, fn));
    };
    add(document, 'visibilitychange', () => this.event(document.visibilityState === 'visible' ? 'page-visible' : 'page-hidden'));
    for (const [event, code] of [['pageshow', 'page-show'], ['pagehide', 'page-hide'], ['online', 'network-online'], ['offline', 'network-offline']]) {
      add(window, event, () => this.event(code));
    }
    add(document, 'freeze', () => this.event('page-freeze'));
    add(document, 'resume', () => this.event('page-resume'));
    if (navigator.serviceWorker) add(navigator.serviceWorker, 'controllerchange', () => this.event('sw-controller-change'));
  }

  async environment(): Promise<void> {
    if (this.#stopped) return;
    const nav = navigator as Navigator & { deviceMemory?: number };
    let estimate: StorageEstimate = {};
    let persisted: boolean | null = null;
    try { estimate = await navigator.storage?.estimate() ?? {}; } catch { /* unknown */ }
    try { persisted = await navigator.storage?.persisted() ?? null; } catch { /* unknown */ }
    let wasmSharedMemory = false;
    try { wasmSharedMemory = typeof SharedArrayBuffer !== 'undefined'
      && new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer instanceof SharedArrayBuffer; } catch { /* absent */ }
    const simdModule = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,
      0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,11]);
    let wasmSimd = false;
    try { wasmSimd = WebAssembly.validate(simdModule); } catch { /* absent */ }
    if (this.#stopped) return;
    this.#metadata.environment = {
      userAgent: normalizedAgent(nav.userAgent), deviceMemoryHintGiB: safeNumber(nav.deviceMemory),
      secureContext: globalThis.isSecureContext, crossOriginIsolated: globalThis.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined', wasmSharedMemory, wasmSimd,
      // API presence is intentionally not called a functional worker test.
      sharedWorkerApi: typeof SharedWorker !== 'undefined', workerApi: typeof Worker !== 'undefined',
      opfsApi: typeof nav.storage?.getDirectory === 'function', webLocksApi: !!nav.locks,
      broadcastChannelApi: typeof BroadcastChannel !== 'undefined', indexedDbApi: typeof indexedDB !== 'undefined',
      serviceWorkerApi: !!nav.serviceWorker, serviceWorkerControllerState: nav.serviceWorker?.controller?.state ?? 'none',
      serviceWorkerBuild: 'unknown-until-version-handshake',
      storage: { usage: safeNumber(estimate.usage), quota: safeNumber(estimate.quota), persisted },
    };
  }

  async probeGpu(): Promise<void> {
    if (this.#stopped) return;
    try {
      const report = await requireWebGpu();
      if (!this.#stopped) { this.#metadata.probeGpu = report; this.event('probe-gpu-pass'); }
    } catch (error) {
      if (!this.#stopped) {
        this.#metadata.probeGpu = { status: 'unavailable', code: error && typeof error === 'object' && 'code' in error
          && typeof error.code === 'string' && /^gpu-[a-z-]+$/.test(error.code) ? error.code : 'gpu-check-failed' };
        this.event('probe-gpu-fail');
      }
    }
  }

  /** Call ONLY with the actual engine-owned GPUDevice. Never pass a probe device. */
  observeRuntimeDevice(device: EventTarget & { limits: object; lost: Promise<{ reason: string }> },
    requestedLimits: Record<string, unknown> = {}): () => void {
    if (this.#stopped) return () => undefined;
    let alive = true;
    this.#metadata.runtimeGpuObserved = true;
    this.#metadata.runtimeGpu = { requestedLimits: safeLimits(requestedLimits), grantedLimits: safeLimits(device.limits) };
    const error = (event: Event) => {
      const name = (event as Event & { error?: { constructor?: { name?: string } } }).error?.constructor?.name;
      this.event(name === 'GPUOutOfMemoryError' ? 'gpu-out-of-memory' : name === 'GPUValidationError' ? 'gpu-validation-error' : 'gpu-error');
    };
    device.addEventListener('uncapturederror', error);
    void device.lost.then(info => {
      if (alive) this.event(info.reason === 'destroyed' ? 'gpu-device-destroyed' : 'gpu-device-lost');
    }, () => { if (alive) this.event('gpu-error'); });
    const cleanup = () => { alive = false; device.removeEventListener('uncapturederror', error); };
    this.#cleanup.push(cleanup);
    return cleanup;
  }

  compilation(info: { messages: ReadonlyArray<{ type: string }> }): void {
    this.event('shader-compilation', { total: info.messages.length,
      received: info.messages.filter(message => message.type === 'error').length,
      verified: info.messages.filter(message => message.type === 'warning').length });
  }
  buffer(bytes: number): void {
    if (safeNumber(bytes) === null) return;
    this.#peakBuffer = Math.max(this.#peakBuffer, bytes);
    this.event('buffer-high-water', { total: this.#peakBuffer });
  }

  async response(response: Response, ordinal: number): Promise<void> {
    if (this.#stopped || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 4096) return;
    const headers = response.headers;
    const range = headers.get('Content-Range');
    const etag = headers.get('ETag');
    let etagFingerprint: string | null = null;
    if (etag && etag.length <= 1024) {
      const hash = await crypto.subtle.digest('SHA-256', encoder.encode(etag));
      etagFingerprint = Array.from(new Uint8Array(hash).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
    }
    if (this.#stopped) return;
    // One latest response summary only; the existing ring holds status history.
    this.#metadata.lastResponse = { ordinal, status: response.status, redirected: response.redirected,
      contentRange: range && /^bytes (\d+-\d+|\*)\/(\d+|\*)$/.test(range) ? range : range ? 'invalid' : null,
      contentLength: headers.has('Content-Length') ? safeNumber(Number(headers.get('Content-Length'))) : null,
      acceptsRanges: headers.get('Accept-Ranges') === 'bytes', etagPresent: !!etag, etagFingerprint,
      lastModifiedPresent: headers.has('Last-Modified'),
      contentEncoding: ['identity', 'gzip', 'br'].includes(headers.get('Content-Encoding') ?? '') ? headers.get('Content-Encoding') : 'absent-or-other',
      contentType: ['application/json', 'application/octet-stream', 'application/wasm', 'text/javascript'].includes(headers.get('Content-Type') ?? '') ? headers.get('Content-Type') : 'other',
      // Header values may contain credentials. Only reviewed flags are exported.
      cacheNoStore: /(?:^|,)\s*no-store\b/.test(headers.get('Cache-Control') ?? ''),
      corsReadable: response.type !== 'opaque', corpCrossOrigin: headers.get('Cross-Origin-Resource-Policy') === 'cross-origin' };
    this.event('range-response', { status: response.status, attempt: ordinal });
  }

  /** Explicit destructive-in-own-scratch-only test; never touches Eva data. */
  async probeOpfs(): Promise<void> {
    if (this.#stopped) return;
    const checks: Record<string, boolean | string> = {};
    let root: FileSystemDirectoryHandle | undefined;
    let name: string | undefined;
    try {
      root = await navigator.storage.getDirectory();
      name = `.kyuby-runtime-probe-${crypto.randomUUID()}`;
      const dir = await root.getDirectoryHandle(name, { create: true });
      let handle = await dir.getFileHandle('probe', { create: true }); checks.create = true;
      const write = async (action: (w: FileSystemWritableFileStream) => Promise<void>) => {
        const w = await handle.createWritable({ keepExistingData: true });
        try { await action(w); await w.close(); } catch (error) { await w.abort().catch(() => undefined); throw error; }
      };
      await write(w => w.write(new Uint8Array([1, 2, 3]))); checks.write = true;
      handle = await dir.getFileHandle('probe');
      checks.reopen = (await handle.getFile()).size === 3;
      await write(async w => { await w.seek(3); await w.write(new Uint8Array([4])); });
      checks.append = Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer())).join(',') === '1,2,3,4';
      await write(w => w.truncate(2)); checks.truncate = (await handle.getFile()).size === 2;
      const move = (handle as FileSystemFileHandle & { move?: (name: string) => Promise<void> }).move;
      if (move) {
        await move.call(handle, 'moved');
        checks.rename = (await (await dir.getFileHandle('moved')).getFile()).size === 2;
        await dir.removeEntry('moved');
      } else { checks.rename = 'unsupported'; await dir.removeEntry('probe'); }
      checks.delete = true;
      this.event(Object.values(checks).every(value => value === true) ? 'probe-opfs-pass' : 'probe-opfs-fail');
    } catch (error) { checks.error = safeError(error); this.event('probe-opfs-fail'); }
    finally {
      if (root && name) {
        try { await root.removeEntry(name, { recursive: true }); checks.cleanup = true; }
        catch { checks.cleanup = false; }
      }
      if (!this.#stopped) this.#metadata.opfsScratchTest = checks;
    }
  }

  async probeIdb(): Promise<void> {
    if (this.#stopped) return;
    const name = `kyuby-runtime-probe-${crypto.randomUUID()}`;
    let db: IDBDatabase | undefined;
    try {
      db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('probe');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Probe blocked.'));
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db!.transaction('probe', 'readwrite');
        tx.objectStore('probe').put(1, 'value');
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      const value = await new Promise<unknown>((resolve, reject) => {
        const tx = db!.transaction('probe'); const get = tx.objectStore('probe').get('value');
        get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
      });
      if (value !== 1) throw new Error('Probe mismatch.');
      if (!this.#stopped) this.#metadata.idbScratchTest = { writeRead: true };
      this.event('probe-idb-pass');
    } catch (error) {
      if (!this.#stopped) this.#metadata.idbScratchTest = { writeRead: false, error: safeError(error) };
      this.event('probe-idb-fail');
    } finally {
      db?.close();
      // Only this uniquely named scratch DB is removed.
      const request = indexedDB.deleteDatabase(name);
      request.onerror = () => this.event('idb-transaction-failed');
    }
  }

  /** Input must be the application's already-sanitized acquisition export.
   * Do not pass arbitrary data. Existing ring remains the only event store.
   */
  exportJson(sanitizedAcquisitionJson: string): string {
    if (encoder.encode(sanitizedAcquisitionJson).byteLength > MAX_EXPORT_BYTES) throw new Error('Diagnostic input is too large.');
    const base = JSON.parse(sanitizedAcquisitionJson) as { events?: unknown[]; dropped?: number; [key: string]: unknown };
    if (!Array.isArray(base.events)) throw new Error('Expected an acquisition diagnostic export.');
    const output = { ...base, runtime: this.#metadata };
    const events = output.events!;
    let json = JSON.stringify(output);
    while ((events.length > MAX_EVENTS || encoder.encode(json).byteLength > MAX_EXPORT_BYTES) && events.length) {
      events.shift(); output.dropped = (safeNumber(output.dropped) ?? 0) + 1; json = JSON.stringify(output);
    }
    if (encoder.encode(json).byteLength > MAX_EXPORT_BYTES) throw new Error('Diagnostic metadata is too large.');
    return json;
  }

  stop(): void { this.#stopped = true; for (const cleanup of this.#cleanup.splice(0)) cleanup(); }
}
