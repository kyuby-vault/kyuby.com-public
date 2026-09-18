import { exactKeys, isRecord, isSandboxCapabilities, isSandboxId, SANDBOX_ERRORS, SANDBOX_MAX_LIST_ENTRIES,
  SANDBOX_MAX_READ_BYTES, resolveSandboxBudgets, type MountGrant, type SandboxBudgets,
  type SandboxCapabilities, type SandboxError } from './capabilities';

export const SANDBOX_PROTOCOL_VERSION = 1;
export type SandboxCommand =
  | { op: 'readText' | 'readBytes' | 'list' | 'remove'; path: string }
  | { op: 'writeText'; path: string; content: string }
  | { op: 'writeBytes'; path: string; content: Uint8Array }
  | { op: 'promote'; path: string; name: string };
export interface SandboxDirEntry { name: string; kind: 'file' | 'directory' }
export interface SandboxRequest { protocolVersion: 1; requestId: string; sessionId: string; command: SandboxCommand }
export type SandboxResponse = { protocolVersion: 1; requestId: string } &
  ({ ok: true; data: string | Uint8Array | SandboxDirEntry[] | null | { promotionId: string } } | { ok: false; error: SandboxError });
export interface SandboxBootstrap {
  type: 'bootstrap'; protocolVersion: 1; requestId: string; sessionId: string; workerId: string;
  mounts: MountGrant[]; capabilities: SandboxCapabilities; budgets: SandboxBudgets; telemetry: { enabled: true };
}
export interface SandboxReady { type: 'ready'; protocolVersion: 1; requestId: string; sessionId: string; workerId: string; bootMs: number }
export interface SandboxTelemetryEvent {
  type: 'telemetry'; protocolVersion: 1; sessionId: string; workerId: string; event: 'operation'; heapEstimateBytes: number | null;
}

export function isSandboxCommand(value: unknown): value is SandboxCommand {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  switch (value.op) {
    case 'readText': case 'readBytes': case 'list': case 'remove': return exactKeys(value, ['op', 'path']);
    case 'writeText': return exactKeys(value, ['op', 'path', 'content']) && typeof value.content === 'string';
    case 'writeBytes': return exactKeys(value, ['op', 'path', 'content']) && value.content instanceof Uint8Array;
    case 'promote': return exactKeys(value, ['op', 'path', 'name']) && typeof value.name === 'string';
    default: return false;
  }
}
export function isSandboxRequest(value: unknown): value is SandboxRequest {
  return isRecord(value) && exactKeys(value, ['protocolVersion', 'requestId', 'sessionId', 'command'])
    && value.protocolVersion === 1 && isSandboxId(value.requestId) && isSandboxId(value.sessionId) && isSandboxCommand(value.command);
}
function isData(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength <= SANDBOX_MAX_READ_BYTES;
  if (value instanceof Uint8Array) return value.byteLength <= SANDBOX_MAX_READ_BYTES;
  if (Array.isArray(value)) return value.length <= SANDBOX_MAX_LIST_ENTRIES && value.every((entry) => isRecord(entry)
    && exactKeys(entry, ['name', 'kind']) && typeof entry.name === 'string' && entry.name.length <= 512
    && !/[\u0000-\u001f\u007f/\\]/.test(entry.name) && (entry.kind === 'file' || entry.kind === 'directory'));
  return isRecord(value) && exactKeys(value, ['promotionId']) && isSandboxId(value.promotionId);
}
export function isSandboxResponse(value: unknown): value is SandboxResponse {
  if (!isRecord(value) || value.protocolVersion !== 1 || !isSandboxId(value.requestId)) return false;
  if (value.ok === true) return exactKeys(value, ['protocolVersion', 'requestId', 'ok', 'data']) && isData(value.data);
  return value.ok === false && exactKeys(value, ['protocolVersion', 'requestId', 'ok', 'error']) && isRecord(value.error)
    && exactKeys(value.error, ['code', 'message']) && typeof value.error.code === 'string' && Object.hasOwn(SANDBOX_ERRORS, value.error.code)
    && value.error.message === SANDBOX_ERRORS[value.error.code as keyof typeof SANDBOX_ERRORS];
}
export function resultMatches(command: SandboxCommand, data: unknown): boolean {
  switch (command.op) {
    case 'readText': return typeof data === 'string';
    case 'readBytes': return data instanceof Uint8Array;
    case 'list': return Array.isArray(data);
    case 'promote': return isRecord(data) && isSandboxId(data.promotionId);
    default: return data === null;
  }
}
export function isSandboxBootstrap(value: unknown): value is SandboxBootstrap {
  if (!isRecord(value) || !exactKeys(value, ['type', 'protocolVersion', 'requestId', 'sessionId', 'workerId', 'mounts', 'capabilities', 'budgets', 'telemetry'])
    || value.type !== 'bootstrap' || value.protocolVersion !== 1 || !isSandboxId(value.requestId)
    || !isSandboxId(value.sessionId) || !isSandboxId(value.workerId) || !isSandboxCapabilities(value.capabilities)
    || JSON.stringify(value.mounts) !== JSON.stringify(value.capabilities.fs.mounts)
    || !isRecord(value.telemetry) || !exactKeys(value.telemetry, ['enabled']) || value.telemetry.enabled !== true || !isRecord(value.budgets)) return false;
  try { return JSON.stringify(resolveSandboxBudgets(value.budgets)) === JSON.stringify(value.budgets); } catch { return false; }
}
export function isSandboxReady(value: unknown): value is SandboxReady {
  return isRecord(value) && exactKeys(value, ['type', 'protocolVersion', 'requestId', 'workerId', 'sessionId', 'bootMs'])
    && value.type === 'ready' && value.protocolVersion === 1 && isSandboxId(value.requestId) && isSandboxId(value.workerId)
    && isSandboxId(value.sessionId) && typeof value.bootMs === 'number' && Number.isFinite(value.bootMs) && value.bootMs >= 0;
}
export function isSandboxTelemetryEvent(value: unknown): value is SandboxTelemetryEvent {
  return isRecord(value) && exactKeys(value, ['type', 'protocolVersion', 'sessionId', 'workerId', 'event', 'heapEstimateBytes'])
    && value.type === 'telemetry' && value.protocolVersion === 1 && isSandboxId(value.sessionId) && isSandboxId(value.workerId)
    && value.event === 'operation' && (value.heapEstimateBytes === null || (Number.isSafeInteger(value.heapEstimateBytes) && Number(value.heapEstimateBytes) >= 0));
}
