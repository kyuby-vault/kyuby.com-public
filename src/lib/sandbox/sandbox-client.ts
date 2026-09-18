import { copySandboxCapabilities, defaultSandboxCapabilities, isRecord, isSandboxId, resolveSandboxBudgets,
  safeSandboxError, sandboxId, SandboxFault, SANDBOX_COMMAND_TIMEOUT_MS, SANDBOX_MAX_SESSIONS_PER_TAB,
  SANDBOX_READY_TIMEOUT_MS, type SandboxBudgets, type SandboxCapabilities } from './capabilities';
import { isSandboxCommand, isSandboxReady, isSandboxRequest, isSandboxResponse, isSandboxTelemetryEvent,
  resultMatches, type SandboxBootstrap, type SandboxCommand } from './protocol';
import { SandboxHostExecutor } from './host-executor';
import { createWorkerProbe, listSandboxObservability, removeSandboxPromotions, SandboxTelemetry, type WorkerProbeRecord } from './telemetry';

type WorkerChannel = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'>;
export interface SandboxSpawnRequest {
  capabilities?: SandboxCapabilities; budgets?: Partial<SandboxBudgets>;
  workerFactory?: (workerId: string) => WorkerChannel; // Trusted host injection for lifecycle unit tests, never a wire capability.
}
interface Pending {
  command: SandboxCommand; resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; detach: () => void;
}
export class SandboxClient extends EventTarget {
  static #sessions = new Set<SandboxClient>();
  static #pagehide = false;
  readonly sessionId = sandboxId();
  readonly workerId = sandboxId();
  readonly spawnedAt = Date.now();
  readonly #handshakeId = sandboxId();
  #worker: WorkerChannel;
  #host: SandboxHostExecutor;
  #telemetry = new SandboxTelemetry();
  #pending = new Map<string, Pending>();
  #capabilities: SandboxCapabilities;
  #dead = false;
  #ready = false;
  #restartCount = 0;
  #bootMs: number | null = null;
  #heapEstimateBytes: number | null = null;
  #spawnResolve?: () => void;
  #spawnReject?: (error: Error) => void;
  #readyTimer?: ReturnType<typeof setTimeout>;
  #ending?: Promise<void>;

  static async spawn(request: SandboxSpawnRequest = {}): Promise<SandboxClient> {
    if (this.#sessions.size >= SANDBOX_MAX_SESSIONS_PER_TAB) throw new SandboxFault('EQUOTA');
    const client = new SandboxClient(request);
    this.#sessions.add(client);
    if (typeof window !== 'undefined' && !this.#pagehide) {
      window.addEventListener('pagehide', () => { for (const session of this.#sessions) void session.#finish('user-terminated'); });
      this.#pagehide = true;
    }
    await client.#start(request.budgets);
    return client;
  }
  private constructor(request: SandboxSpawnRequest) {
    super();
    this.#capabilities = copySandboxCapabilities(request.capabilities ?? defaultSandboxCapabilities());
    // There is no catalog content source in Slice 3, even if a host caller supplies a grant.
    if (this.#capabilities.fs.mounts.some((mount) => mount.blocks?.length)) throw new SandboxFault('EACCES');
    resolveSandboxBudgets(request.budgets);
    this.#worker = request.workerFactory?.(this.workerId)
      ?? new Worker(new URL('../../workers/sandbox.worker.ts', import.meta.url), { type: 'module', name: `eva-sandbox-${this.workerId}` });
    this.#host = new SandboxHostExecutor({ sessionId: this.sessionId, workerId: this.workerId,
      capabilities: this.#capabilities, budgets: request.budgets,
      readWorkspace: (path, signal) => this.#send('host-read', { op: 'readBytes', path }, signal) as Promise<Uint8Array>,
      activity: (event) => this.#telemetry.append(event) });
    this.#worker.addEventListener('message', this.#message as EventListener);
    this.#worker.addEventListener('error', this.#crash);
    this.#worker.addEventListener('messageerror', this.#crash);
  }
  get live(): boolean { return this.#ready && !this.#dead; }
  #start(budgets?: Partial<SandboxBudgets>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#spawnResolve = resolve; this.#spawnReject = reject;
      this.#readyTimer = setTimeout(() => { void this.#finish('unknown'); }, SANDBOX_READY_TIMEOUT_MS);
      const frame: SandboxBootstrap = { type: 'bootstrap', protocolVersion: 1, requestId: this.#handshakeId,
        sessionId: this.sessionId, workerId: this.workerId, mounts: this.#capabilities.fs.mounts,
        capabilities: this.#capabilities, budgets: resolveSandboxBudgets(budgets), telemetry: { enabled: true } };
      try { this.#worker.postMessage(frame); } catch { void this.#finish('unknown'); }
    });
  }
  #probe(lastReason: WorkerProbeRecord['lastReason']): void {
    this.#telemetry.append(createWorkerProbe({ workerId: this.workerId, sessionId: this.sessionId,
      spawnedAt: this.spawnedAt, bootMs: this.#bootMs, heapEstimateBytes: this.#heapEstimateBytes,
      restartCount: this.#restartCount, lastReason, mountsGranted: this.#capabilities.fs.mounts.map((mount) => mount.path) }));
  }
  #message = (event: MessageEvent<unknown>): void => {
    if (this.#dead) return;
    const frame = event.data;
    if (isSandboxReady(frame)) {
      if (this.#ready || frame.requestId !== this.#handshakeId || frame.workerId !== this.workerId || frame.sessionId !== this.sessionId) return;
      clearTimeout(this.#readyTimer); this.#ready = true; this.#bootMs = Date.now() - this.spawnedAt;
      this.#probe('first-start'); this.#spawnResolve?.(); this.#spawnResolve = undefined; this.#spawnReject = undefined;
    } else if (isSandboxResponse(frame)) {
      const request = this.#pending.get(frame.requestId);
      if (!request) return;
      this.#pending.delete(frame.requestId); clearTimeout(request.timer); request.detach();
      if (!frame.ok) request.reject(new SandboxFault(frame.error.code));
      else if (!resultMatches(request.command, frame.data)) request.reject(new SandboxFault('EBADMSG'));
      else request.resolve(frame.data);
    } else if (isSandboxTelemetryEvent(frame)) {
      if (!this.live || frame.sessionId !== this.sessionId || frame.workerId !== this.workerId) return;
      this.#heapEstimateBytes = frame.heapEstimateBytes; this.#probe('first-start');
    } else if (isSandboxRequest(frame) || (isRecord(frame) && isSandboxId(frame.requestId) && 'command' in frame)) {
      if (!this.live) return;
      void this.#host.handle(frame).then((response) => { if (response && !this.#dead) this.#worker.postMessage(response); });
    }
  };
  #crash = (event: Event): void => { event.preventDefault(); void this.#finish('crash'); };
  #send(type: 'host-read' | 'DEV_SANDBOX_EXECUTE', command: SandboxCommand, signal?: AbortSignal): Promise<unknown> {
    if (!this.live) return Promise.reject(new SandboxFault('EACCES'));
    if (!isSandboxCommand(command)) return Promise.reject(new SandboxFault('EBADMSG'));
    if (signal?.aborted) return Promise.reject(new SandboxFault('EBOUND'));
    const requestId = sandboxId();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer); pending.detach(); this.#pending.delete(requestId); reject(new SandboxFault('EBOUND'));
      };
      const timer = setTimeout(cancel, SANDBOX_COMMAND_TIMEOUT_MS + 2000);
      const detach = () => signal?.removeEventListener('abort', cancel);
      this.#pending.set(requestId, { command, resolve, reject, timer, detach });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.#worker.postMessage({ type, protocolVersion: 1, requestId, sessionId: this.sessionId, command }); }
      catch { clearTimeout(timer); detach(); this.#pending.delete(requestId); reject(new SandboxFault('EBADMSG')); }
    });
  }
  executeForTest(command: SandboxCommand): Promise<unknown> {
    if (!import.meta.env.DEV) return Promise.reject(new SandboxFault('EACCES'));
    return this.#send('DEV_SANDBOX_EXECUTE', command);
  }
  crashForTest(): void {
    if (!import.meta.env.DEV || !this.live) throw new SandboxFault('EACCES');
    this.#worker.postMessage({ type: 'DEV_SANDBOX_FAULT', protocolVersion: 1, requestId: sandboxId(), sessionId: this.sessionId });
  }
  endSession(): Promise<void> { return this.#finish('clean-exit'); }
  #finish(reason: WorkerProbeRecord['lastReason']): Promise<void> {
    if (this.#ending) return this.#ending;
    this.#dead = true; this.#ready = false; clearTimeout(this.#readyTimer);
    if (reason === 'crash') this.#restartCount++;
    this.#worker.terminate(); this.#host.close();
    this.#worker.removeEventListener('message', this.#message as EventListener);
    this.#worker.removeEventListener('error', this.#crash); this.#worker.removeEventListener('messageerror', this.#crash);
    this.#spawnReject?.(new SandboxFault('EACCES')); this.#spawnReject = undefined; this.#spawnResolve = undefined;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.detach(); pending.reject(new SandboxFault('EACCES')); }
    this.#pending.clear(); SandboxClient.#sessions.delete(this); this.#probe(reason);
    void this.#telemetry.flush(); // Observability must not delay termination or temporary-output cleanup.
    this.#ending = (async () => {
      try { await removeSandboxPromotions(this.sessionId); } catch { console.warn('Sandbox temporary cleanup unavailable.'); }
    })();
    return this.#ending;
  }
  flushTelemetry(): Promise<void> { return this.#telemetry.flush(); }
}

/** This hook and its dynamic import disappear from the production chat bundle. No model or product UI is initialized. */
export function installSandboxFixture(): void {
  if (!import.meta.env.DEV) return;
  const sessions = new Map<string, SandboxClient>();
  const api = {
    async spawn() {
      const client = await SandboxClient.spawn(); sessions.set(client.sessionId, client);
      return { sessionId: client.sessionId, workerId: client.workerId };
    },
    async execute(sessionId: string, command: SandboxCommand) {
      try {
        const client = sessions.get(sessionId); if (!client) throw new SandboxFault('EACCES');
        return { ok: true as const, data: await client.executeForTest(command) };
      } catch (error) { return { ok: false as const, error: safeSandboxError(error) }; }
    },
    async end(sessionId: string) { await sessions.get(sessionId)?.endSession(); sessions.delete(sessionId); },
    crash(sessionId: string) { sessions.get(sessionId)?.crashForTest(); },
    async telemetry() { await Promise.all([...sessions.values()].map((client) => client.flushTelemetry())); return listSandboxObservability(); },
  };
  Object.defineProperty(window, '__evaSandbox', { value: api, configurable: true });
}
