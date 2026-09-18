export const SANDBOX_MAX_OPS_PER_SESSION = 10_000;
export const SANDBOX_MAX_READ_BYTES = 1024 * 1024;
export const SANDBOX_MAX_WRITE_BYTES = 1024 * 1024;
export const SANDBOX_WORKSPACE_MAX_BYTES = 64 * 1024 * 1024;
export const SANDBOX_MAX_LIST_ENTRIES = 1_000;
export const SANDBOX_MAX_PATH_BYTES = 512;
export const SANDBOX_MAX_PROMOTED_BYTES_PER_SESSION = 16 * 1024 * 1024;
export const SANDBOX_MAX_SESSIONS_PER_TAB = 4;
export const SANDBOX_COMMAND_TIMEOUT_MS = 30_000;
export const SANDBOX_READY_TIMEOUT_MS = 10_000;

export interface MountGrant { path: '/workspace' | '/blocks'; access: 'rw' | 'ro'; blocks?: string[] }
export interface SandboxCapabilities { fs: { mounts: MountGrant[] }; net: null; mcp: null }
export const SANDBOX_BUDGETS = Object.freeze({ ops: SANDBOX_MAX_OPS_PER_SESSION,
  readBytes: SANDBOX_MAX_READ_BYTES, writeBytes: SANDBOX_MAX_WRITE_BYTES,
  workspaceBytes: SANDBOX_WORKSPACE_MAX_BYTES, listEntries: SANDBOX_MAX_LIST_ENTRIES,
  pathBytes: SANDBOX_MAX_PATH_BYTES, promotedBytes: SANDBOX_MAX_PROMOTED_BYTES_PER_SESSION });
export type SandboxBudgets = { [Key in keyof typeof SANDBOX_BUDGETS]: number };
export const SANDBOX_ERRORS = Object.freeze({ ENOENT: 'Sandbox entry does not exist.', EACCES: 'Sandbox access denied.',
  EROFS: 'Sandbox mount is read-only.', EBOUND: 'Sandbox command exceeded its bounds.',
  EQUOTA: 'Sandbox storage budget exceeded.', EBADMSG: 'Invalid sandbox message.' });
export type SandboxErrorCode = keyof typeof SANDBOX_ERRORS;
export interface SandboxError { code: SandboxErrorCode; message: string }
export class SandboxFault extends Error {
  constructor(readonly code: SandboxErrorCode) { super(SANDBOX_ERRORS[code]); this.name = 'SandboxFault'; }
}
export function safeSandboxError(error: unknown): SandboxError {
  const code = error instanceof SandboxFault ? error.code
    : error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError' ? 'EQUOTA' : 'EACCES';
  return { code, message: SANDBOX_ERRORS[code] };
}
export function defaultSandboxCapabilities(): SandboxCapabilities {
  return { fs: { mounts: [{ path: '/workspace', access: 'rw' }, { path: '/blocks', access: 'ro', blocks: [] }] }, net: null, mcp: null };
}
export function resolveSandboxBudgets(input: Partial<SandboxBudgets> = {}): SandboxBudgets {
  const budgets = { ...SANDBOX_BUDGETS, ...input };
  if (Object.keys(budgets).length !== Object.keys(SANDBOX_BUDGETS).length) throw new SandboxFault('EBADMSG');
  for (const key of Object.keys(SANDBOX_BUDGETS) as (keyof SandboxBudgets)[]) {
    if (!Number.isSafeInteger(budgets[key]) || budgets[key] < 1 || budgets[key] > SANDBOX_BUDGETS[key]) throw new SandboxFault('EBOUND');
  }
  return Object.freeze(budgets);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
export function isSandboxId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
export function isSandboxCapabilities(value: unknown): value is SandboxCapabilities {
  if (!isRecord(value) || !exactKeys(value, ['fs', 'net', 'mcp']) || value.net !== null || value.mcp !== null
    || !isRecord(value.fs) || !exactKeys(value.fs, ['mounts']) || !Array.isArray(value.fs.mounts)
    || value.fs.mounts.length < 1 || value.fs.mounts.length > 2) return false;
  const seen = new Set<string>();
  for (const grant of value.fs.mounts) {
    if (!isRecord(grant) || !exactKeys(grant, ['path', 'access'], ['blocks'])
      || (grant.path !== '/workspace' && grant.path !== '/blocks') || seen.has(grant.path)) return false;
    seen.add(grant.path);
    if (grant.path === '/workspace' && (grant.access !== 'rw' || 'blocks' in grant)) return false;
    if (grant.path === '/blocks' && (grant.access !== 'ro' || !Array.isArray(grant.blocks)
      || grant.blocks.length > SANDBOX_MAX_LIST_ENTRIES || !grant.blocks.every(isSandboxId)
      || new Set(grant.blocks).size !== grant.blocks.length)) return false;
  }
  return seen.has('/workspace');
}
export function copySandboxCapabilities(value: SandboxCapabilities): SandboxCapabilities {
  if (!isSandboxCapabilities(value)) throw new SandboxFault('EBADMSG');
  const copy = structuredClone(value);
  for (const mount of copy.fs.mounts) { if (mount.blocks) Object.freeze(mount.blocks); Object.freeze(mount); }
  Object.freeze(copy.fs.mounts); Object.freeze(copy.fs);
  return Object.freeze(copy);
}

/** UUID v7: 48-bit Unix milliseconds, random tail, RFC version/variant bits. */
export function sandboxId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index--) { bytes[index] = timestamp % 256; timestamp = Math.floor(timestamp / 256); }
  bytes[6] = (bytes[6] & 15) | 0x70; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
