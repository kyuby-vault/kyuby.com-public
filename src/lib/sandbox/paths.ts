import { SANDBOX_MAX_PATH_BYTES, SandboxFault } from './capabilities';

export function normalizeSandboxPath<Mount extends { path: string; access: 'ro' | 'rw' }>(
  input: unknown, mounts: readonly Mount[],
): { path: string; segments: string[]; mount: Mount; relative: string[] } {
  if (typeof input !== 'string' || !input.length || /[\u0000-\u001f\u007f\\?#]/.test(input) || input[0] !== '/') {
    throw new SandboxFault('EBADMSG');
  }
  if (new TextEncoder().encode(input).byteLength > SANDBOX_MAX_PATH_BYTES) throw new SandboxFault('EBOUND');
  const segments = input.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new SandboxFault('EACCES');
  // Longest mount-root match on normalized path segments, NOT string-prefix matching.
  let match: { mount: Mount; depth: number } | undefined;
  for (const mount of mounts) {
    const root = mount.path.split('/').filter(Boolean);
    if (root.length > 0 && root.length <= segments.length && root.every((part, index) => part === segments[index])
      && (!match || root.length > match.depth)) match = { mount, depth: root.length };
  }
  if (!match) throw new SandboxFault('EACCES');
  return { path: `/${segments.join('/')}`, segments, mount: match.mount, relative: segments.slice(match.depth) };
}

export function checkSandboxAccess(mount: { access: 'ro' | 'rw' }, op: string): void {
  if (mount.access === 'ro' && ['writeText', 'writeBytes', 'remove', 'promote'].includes(op)) throw new SandboxFault('EROFS');
}
