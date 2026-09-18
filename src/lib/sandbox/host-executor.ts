import { copySandboxCapabilities, defaultSandboxCapabilities, isRecord, isSandboxId, resolveSandboxBudgets,
  safeSandboxError, sandboxId, SandboxFault, SANDBOX_COMMAND_TIMEOUT_MS,
  type SandboxBudgets, type SandboxCapabilities } from './capabilities';
import { normalizeSandboxPath, checkSandboxAccess } from './paths';
import { isSandboxRequest, type SandboxRequest, type SandboxResponse } from './protocol';
import { storeSandboxPromotion, type SandboxPromotion, type SandboxObservabilityRecord } from './telemetry';

export interface SandboxHostOptions {
  sessionId: string; workerId: string; capabilities?: SandboxCapabilities; budgets?: Partial<SandboxBudgets>;
  readWorkspace: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
  // Future catalog seam, only ever called for explicitly granted block IDs. Slice 3 installs no reader or grants.
  readBlock?: (blockId: string, signal: AbortSignal) => Promise<Uint8Array>;
  persistPromotion?: (record: SandboxPromotion, signal: AbortSignal) => Promise<void>;
  activity?: (event: Extract<SandboxObservabilityRecord, { kind: 'command-failure' }>) => void;
}

export class SandboxHostExecutor {
  #capabilities: SandboxCapabilities;
  #budgets: SandboxBudgets;
  #ops = 0;
  #promotedBytes = 0;
  #live = true;
  #seen = new Set<string>();
  #active = new Set<AbortController>();
  constructor(private options: SandboxHostOptions) {
    this.options = { ...options }; // Bind lineage/callbacks as well as grants; caller mutations cannot retarget this channel.
    this.#capabilities = copySandboxCapabilities(options.capabilities ?? defaultSandboxCapabilities());
    this.#budgets = resolveSandboxBudgets(options.budgets);
  }
  close(): void { this.#live = false; for (const controller of this.#active) controller.abort(); this.#active.clear(); }
  async handle(frame: unknown): Promise<SandboxResponse | null> {
    // Uncorrelatable input and duplicate/stale IDs are silently dropped.
    if (!isRecord(frame) || !isSandboxId(frame.requestId)) return null;
    const requestId = frame.requestId;
    const fail = (error: unknown): SandboxResponse => ({ protocolVersion: 1, requestId, ok: false, error: safeSandboxError(error) });
    if (!isSandboxRequest(frame)) return fail(new SandboxFault('EBADMSG'));
    if (!this.#live || frame.sessionId !== this.options.sessionId) return fail(new SandboxFault('EACCES'));
    if (this.#seen.has(requestId)) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const resolved = normalizeSandboxPath(frame.command.path, this.#capabilities.fs.mounts);
      checkSandboxAccess(resolved.mount, frame.command.op);
      if ((resolved.mount.path === '/workspace' && frame.command.op !== 'promote')
        || (resolved.mount.path === '/blocks' && !['readText', 'readBytes', 'list'].includes(frame.command.op))) throw new SandboxFault('EACCES');
      if (new TextEncoder().encode(resolved.path).byteLength > this.#budgets.pathBytes || this.#ops >= this.#budgets.ops) throw new SandboxFault('EBOUND');
      this.#ops++; this.#seen.add(requestId);
      this.#active.add(controller);
      const deadline = new Promise<never>((_resolve, reject) => {
        const cancelled = () => reject(new SandboxFault(this.#live ? 'EBOUND' : 'EACCES'));
        controller.signal.addEventListener('abort', cancelled, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          // Fixed bounded event only; diagnostics never disclose a path, name, payload, or exception.
          try { this.options.activity?.({ kind: 'command-failure', probeId: sandboxId(), recordedAt: Date.now(),
            storageClass: 'agent-temp', sessionId: this.options.sessionId, workerId: this.options.workerId,
            code: 'EBOUND', reason: 'command-timeout' }); } catch {}
        }, SANDBOX_COMMAND_TIMEOUT_MS);
      });
      const data = await Promise.race([this.#execute(frame, controller.signal), deadline]);
      if (!this.#live || controller.signal.aborted) throw new SandboxFault('EACCES');
      return { protocolVersion: 1, requestId, ok: true, data };
    } catch (error) { return fail(error); }
    finally { clearTimeout(timer); this.#active.delete(controller); }
  }
  async #execute(request: SandboxRequest, signal: AbortSignal): Promise<Extract<SandboxResponse, { ok: true }>['data']> {
    const command = request.command;
    const resolved = normalizeSandboxPath(command.path, this.#capabilities.fs.mounts);
    const assertLive = () => { if (signal.aborted || !this.#live) throw new SandboxFault('EACCES'); };
    if (command.op === 'promote') {
      if (!command.name.length || command.name.length > 128 || /[\u0000-\u001f\u007f/\\]/.test(command.name)) throw new SandboxFault('EBADMSG');
      const content = await this.options.readWorkspace(resolved.path, signal);
      assertLive();
      if (!(content instanceof Uint8Array)) throw new SandboxFault('EBADMSG');
      if (content.byteLength > this.#budgets.writeBytes || this.#promotedBytes + content.byteLength > this.#budgets.promotedBytes) throw new SandboxFault('EQUOTA');
      const bytes = new Uint8Array(content);
      const promotionId = sandboxId();
      this.#promotedBytes += bytes.byteLength; // Reserve before awaiting storage: concurrent promotions share one cap.
      try {
        await (this.options.persistPromotion ?? storeSandboxPromotion)({ kind: 'promotion', probeId: promotionId,
          storageClass: 'agent-temp', recordedAt: Date.now(), sessionId: this.options.sessionId,
          workerId: this.options.workerId, name: command.name, bytes }, signal);
        assertLive();
      } catch (error) { this.#promotedBytes -= bytes.byteLength; throw error; }
      return { promotionId };
    }
    const ids = resolved.mount.blocks ?? [];
    if (!ids.length) throw new SandboxFault('ENOENT');
    if (command.op === 'list' && !resolved.relative.length) {
      if (ids.length > this.#budgets.listEntries) throw new SandboxFault('EBOUND');
      return [...ids].sort().map((name) => ({ name, kind: 'file' as const }));
    }
    if (resolved.relative.length !== 1 || !ids.includes(resolved.relative[0]) || !this.options.readBlock) throw new SandboxFault('ENOENT');
    const bytes = await this.options.readBlock(resolved.relative[0], signal);
    assertLive();
    if (!(bytes instanceof Uint8Array)) throw new SandboxFault('EBADMSG');
    if (bytes.byteLength > this.#budgets.readBytes) throw new SandboxFault('EQUOTA');
    if (command.op === 'readBytes') return new Uint8Array(bytes);
    if (command.op !== 'readText') throw new SandboxFault('ENOENT');
    const text = new TextDecoder().decode(bytes);
    if (new TextEncoder().encode(text).byteLength > this.#budgets.readBytes) throw new SandboxFault('EQUOTA');
    return text;
  }
}
