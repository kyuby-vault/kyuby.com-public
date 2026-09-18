import { Volume } from 'memfs';
import { copySandboxCapabilities, defaultSandboxCapabilities, resolveSandboxBudgets, SandboxFault, type SandboxBudgets,
  type SandboxCapabilities } from './capabilities';
import { checkSandboxAccess, normalizeSandboxPath } from './paths';
import { isSandboxCommand, type SandboxCommand, type SandboxDirEntry, type SandboxResponse } from './protocol';

export interface SandboxVolume {
  readText(path: string): string;
  writeText(path: string, content: string): void;
  readBytes(path: string): Uint8Array;
  writeBytes(path: string, content: Uint8Array): void;
  list(path: string): SandboxDirEntry[];
  remove(path: string): void;
  usageBytes(): number;
}

type VolumeDirEntry = Extract<ReturnType<Volume['readdirSync']>[number], { isDirectory(): boolean }>;

/** Private POSIX volume per Worker; only the bounded SandboxVolume facade is exposed. */
export class MemfsSandboxVolume implements SandboxVolume {
  #fs = Volume.fromJSON({}, '/', { process: { cwd: () => '/', platform: 'linux', env: {}, emitWarning: () => {} } });
  #bytes = 0;
  #budgets: SandboxBudgets;
  constructor(budgets: Partial<SandboxBudgets> = {}) {
    this.#budgets = resolveSandboxBudgets(budgets);
    this.#fs.mkdirSync('/workspace');
  }
  #path(path: string): string {
    return normalizeSandboxPath(path, [{ path: '/workspace', access: 'rw' }]).path;
  }
  #safe<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) {
      if (error instanceof SandboxFault) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      // Never expose memfs paths, Node errors, or stacks across the FsCommand boundary.
      throw new SandboxFault(code === 'ENOENT' ? 'ENOENT' : code === 'ENOSPC' ? 'EQUOTA' : 'EACCES');
    }
  }
  readBytes(path: string): Uint8Array {
    path = this.#path(path);
    return this.#safe(() => {
      const stat = this.#fs.lstatSync(path);
      if (!stat.isFile()) throw new SandboxFault('EACCES');
      if (Number(stat.size) > this.#budgets.readBytes) throw new SandboxFault('EQUOTA');
      return new Uint8Array(this.#fs.readFileSync(path) as Uint8Array);
    });
  }
  readText(path: string): string {
    const text = new TextDecoder().decode(this.readBytes(path));
    if (new TextEncoder().encode(text).byteLength > this.#budgets.readBytes) throw new SandboxFault('EQUOTA');
    return text;
  }
  writeText(path: string, content: string): void { this.writeBytes(path, new TextEncoder().encode(content)); }
  writeBytes(path: string, content: Uint8Array): void {
    path = this.#path(path);
    this.#safe(() => {
      const stat = this.#fs.lstatSync(path, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) throw new SandboxFault('EACCES');
      if (content.byteLength > this.#budgets.writeBytes) throw new SandboxFault('EQUOTA');
      const next = this.#bytes - Number(stat?.size ?? 0) + content.byteLength;
      if (next > this.#budgets.workspaceBytes) throw new SandboxFault('EQUOTA');
      const segments = path.split('/').filter(Boolean);
      const parents = segments.slice(0, -1).map((_part, index) => '/' + segments.slice(0, index + 1).join('/'));
      for (const parent of parents) {
        const directory = this.#fs.lstatSync(parent, { throwIfNoEntry: false });
        if (directory && !directory.isDirectory()) throw new SandboxFault('EACCES');
      }
      // Admit and copy before mutating directory metadata or bytes; memfs never escapes this facade.
      const bytes = new Uint8Array(content);
      this.#fs.mkdirSync(parents[parents.length - 1], { recursive: true });
      this.#fs.writeFileSync(path, bytes);
      this.#bytes = next;
    });
  }
  list(path: string): SandboxDirEntry[] {
    path = this.#path(path);
    return this.#safe(() => {
      // memfs's declaration returns a union even when withFileTypes is literal true.
      const entries = this.#fs.readdirSync(path, { withFileTypes: true }) as VolumeDirEntry[];
      if (entries.length > this.#budgets.listEntries) throw new SandboxFault('EBOUND');
      return entries.map((entry): SandboxDirEntry => {
        if (!entry.isDirectory() && !entry.isFile()) throw new SandboxFault('EACCES');
        return { name: String(entry.name), kind: entry.isDirectory() ? 'directory' : 'file' };
      }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    });
  }
  remove(path: string): void {
    path = this.#path(path);
    if (path === '/workspace') throw new SandboxFault('EACCES');
    this.#safe(() => {
      const stat = this.#fs.lstatSync(path);
      if (stat.isFile()) { this.#fs.unlinkSync(path); this.#bytes -= Number(stat.size); }
      else if (stat.isDirectory()) this.#fs.rmdirSync(path);
      else throw new SandboxFault('EACCES');
    });
  }
  usageBytes(): number { return this.#bytes; }
}

export class SandboxWorkspaceExecutor {
  #remaining: number;
  #capabilities: SandboxCapabilities;
  #budgets: SandboxBudgets;
  constructor(private volume: SandboxVolume, capabilities = defaultSandboxCapabilities(), budgets: Partial<SandboxBudgets> = {}) {
    this.#capabilities = copySandboxCapabilities(capabilities); this.#budgets = resolveSandboxBudgets(budgets); this.#remaining = this.#budgets.ops;
  }
  execute(input: unknown): Extract<SandboxResponse, { ok: true }>['data'] {
    if (!isSandboxCommand(input)) throw new SandboxFault('EBADMSG');
    const command: SandboxCommand = input;
    const { path, mount } = normalizeSandboxPath(command.path, this.#capabilities.fs.mounts);
    checkSandboxAccess(mount, command.op);
    if (mount.path !== '/workspace' || command.op === 'promote') throw new SandboxFault('EACCES');
    if (new TextEncoder().encode(path).byteLength > this.#budgets.pathBytes || this.#remaining-- <= 0) throw new SandboxFault('EBOUND');
    switch (command.op) {
      case 'readText': return this.volume.readText(path);
      case 'readBytes': return this.volume.readBytes(path);
      case 'writeText': this.volume.writeText(path, command.content); break;
      case 'writeBytes': this.volume.writeBytes(path, command.content); break;
      case 'list': return this.volume.list(path);
      case 'remove': this.volume.remove(path); break;
    }
    return null;
  }
}
