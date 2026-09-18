/// <reference lib="webworker" />
import { copySandboxCapabilities, isRecord, isSandboxId, safeSandboxError, sandboxId, SandboxFault,
  SANDBOX_COMMAND_TIMEOUT_MS } from '../lib/sandbox/capabilities';
import { isSandboxBootstrap, isSandboxCommand, isSandboxResponse, resultMatches,
  type SandboxBootstrap, type SandboxCommand, type SandboxResponse } from '../lib/sandbox/protocol';
import { normalizeSandboxPath, checkSandboxAccess } from '../lib/sandbox/paths';
import { MemfsSandboxVolume, SandboxWorkspaceExecutor } from '../lib/sandbox/volume';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let bootstrap: SandboxBootstrap | null = null;
let workspace: SandboxWorkspaceExecutor;
type CommandData = Extract<SandboxResponse, { ok: true }>['data'];
const pending = new Map<string, { command: SandboxCommand; resolve: (data: CommandData) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> }>();

function respond(requestId: string, error: unknown): void {
  scope.postMessage({ protocolVersion: 1, requestId, ok: false, error: safeSandboxError(error) });
}
function emitTelemetry(): void {
  if (!bootstrap) return;
  const used = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
  scope.postMessage({ protocolVersion: 1, type: 'telemetry', workerId: bootstrap.workerId, sessionId: bootstrap.sessionId,
    event: 'operation', heapEstimateBytes: Number.isSafeInteger(used) && used! >= 0 ? used : null });
}
async function execute(command: SandboxCommand): Promise<CommandData> {
  if (!bootstrap) throw new SandboxFault('EACCES');
  if (!isSandboxCommand(command)) throw new SandboxFault('EBADMSG');
  const resolved = normalizeSandboxPath(command.path, bootstrap.mounts);
  checkSandboxAccess(resolved.mount, command.op);
  if (resolved.mount.path === '/workspace' && command.op !== 'promote') return workspace.execute(command);
  const requestId = sandboxId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new SandboxFault('EBOUND')); }, SANDBOX_COMMAND_TIMEOUT_MS + 1000);
    pending.set(requestId, { command, resolve, reject, timer });
    scope.postMessage({ protocolVersion: 1, requestId, sessionId: bootstrap!.sessionId, command });
  });
}

scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const frame = event.data;
  if (isSandboxResponse(frame)) {
    const request = pending.get(frame.requestId);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(frame.requestId);
    if (!frame.ok) request.reject(new SandboxFault(frame.error.code));
    else if (!resultMatches(request.command, frame.data)) request.reject(new SandboxFault('EBADMSG'));
    else request.resolve(frame.data);
    return;
  }
  if (!isRecord(frame) || !isSandboxId(frame.requestId)) return;
  if (!bootstrap) {
    if (!isSandboxBootstrap(frame)) { respond(frame.requestId, new SandboxFault('EBADMSG')); return; }
    const started = performance.now();
    bootstrap = structuredClone(frame);
    const capabilities = copySandboxCapabilities(bootstrap.capabilities);
    bootstrap.mounts = capabilities.fs.mounts;
    workspace = new SandboxWorkspaceExecutor(new MemfsSandboxVolume(bootstrap.budgets), capabilities, bootstrap.budgets);
    scope.postMessage({ protocolVersion: 1, type: 'ready', requestId: bootstrap.requestId,
      workerId: bootstrap.workerId, sessionId: bootstrap.sessionId, bootMs: performance.now() - started });
    return;
  }
  if (frame.protocolVersion !== 1 || frame.sessionId !== bootstrap.sessionId) {
    respond(frame.requestId, new SandboxFault('EACCES')); return;
  }
  if (frame.type === 'host-read' && isSandboxCommand(frame.command) && frame.command.op === 'readBytes') {
    try { scope.postMessage({ protocolVersion: 1, requestId: frame.requestId, ok: true, data: workspace.execute(frame.command) }); }
    catch (error) { respond(frame.requestId, error); }
    return;
  }
  // Trusted test driver only. Production has neither an execution loader nor a fault injection surface.
  if (import.meta.env.DEV) {
    if (frame.type === 'DEV_SANDBOX_FAULT') throw new Error('Sandbox fixture crash.');
    if (frame.type === 'DEV_SANDBOX_EXECUTE') {
      if (!isSandboxCommand(frame.command)) { respond(frame.requestId, new SandboxFault('EBADMSG')); return; }
      const requestId = frame.requestId;
      void execute(frame.command).then((data) => {
        scope.postMessage({ protocolVersion: 1, requestId, ok: true, data } satisfies SandboxResponse);
      }, (error) => respond(requestId, error)).finally(emitTelemetry);
      return;
    }
  }
  respond(frame.requestId, new SandboxFault('EBADMSG'));
});
