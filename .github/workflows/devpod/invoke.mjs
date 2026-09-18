import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const readOnly = ['src', 'public', 'tests', 'integrations', 'docs', 'package.json', 'package-lock.json',
  '.nvmrc', 'tsconfig.json', 'astro.config.mjs', 'playwright.config.ts', 'vitest.config.ts', 'wrangler.jsonc', 'scripts',
  '.github/workflows', 'Containerfile', '.dockerignore'];
export const volumes = ['kyuby-node-modules', 'kyuby-astro-cache'];
export const outputs = ['dist', 'test-results'];
const rootCopies = { Containerfile: 'Containerfile', Makefile: 'Makefile', '.dockerignore': 'dockerignore' };
export function run(command, args, { capture = false, env = process.env } = {}) {
  // Never join arguments into a shell command or include secret values in diagnostics.
  const result = spawnSync(command, args, { encoding: 'utf8', env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed; DevPod stopped.`);
  return capture ? result.stdout.trim() : '';
}
export function assertSafeInput(root, path) {
  const full = join(root, path);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || /(^|[\\/])(\.git|\.credentials|\.env[^\\/]*|\.dev\.vars[^\\/]*)([\\/]|$)/i.test(path)) {
    throw new Error('Refusing a linked or credential-bearing DevPod input.');
  }
  const rel = relative(root, realpathSync(full));
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('Input escapes workspace.');
  if (stat.isDirectory()) for (const name of readdirSync(full)) assertSafeInput(root, join(path, name));
}
export function assertCopies(root) {
  for (const [name, copy] of Object.entries(rootCopies)) {
    if (existsSync(join(root, name)) && readFileSync(join(root, name), 'utf8') !== readFileSync(join(root, '.github/workflows/devpod', copy), 'utf8')) {
      throw new Error(`Root ${name} differs from its exportable CI copy.`);
    }
  }
}
export function previewBranch(branch) {
  return ('local-' + (branch.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'detached')).slice(0, 63).replace(/-+$/g, '');
}
export function containerArgs(root, target, env = process.env, { engine = env.CONTAINER_ENGINE || 'podman', image = env.DEVPOD_IMAGE || 'localhost/kyuby-devpod' } = {}) {
  if (!['podman', 'docker'].includes(engine)) throw new Error('CONTAINER_ENGINE must be podman or docker.');
  const args = ['run', '--rm', '--init', '--ipc=host', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user', '1001:1001', '--workdir', '/workspace'];
  if (engine === 'podman') args.push('--userns=keep-id:uid=1001,gid=1001');
  for (const path of ['/tmp', '/home/appuser', '/workspace/.wrangler']) args.push('--tmpfs', `${path}:rw,mode=1777`);
  const publicSnapshot = env.GITHUB_REPOSITORY === 'kyuby-vault/kyuby.com-public' && existsSync(join(root, 'PUBLIC-SNAPSHOT.json'));
  for (const path of readOnly) {
    if (!existsSync(join(root, path))) {
      if (publicSnapshot && ['tests', 'docs', 'scripts', 'playwright.config.ts', 'vitest.config.ts'].includes(path)) continue;
      throw new Error(`Missing required DevPod input: ${path}`);
    }
    assertSafeInput(root, path);
    args.push('--mount', `type=bind,source=${join(root, path)},target=/workspace/${path},readonly`);
  }
  // Support files are reviewed code, not a mount of the whole .github or repo root.
  assertSafeInput(root, '.github/workflows/devpod');
  args.push('--mount', `type=bind,source=${join(root, '.github/workflows/devpod')},target=/opt/kyuby-devpod,readonly`);
  args.push('--mount', `type=bind,source=${join(root, '.github/workflows/devpod/Makefile')},target=/workspace/Makefile,readonly`);
  if (publicSnapshot) {
    assertSafeInput(root, 'PUBLIC-SNAPSHOT.json');
    const snapshot = JSON.parse(readFileSync(join(root, 'PUBLIC-SNAPSHOT.json'), 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(snapshot.upstreamCommit) || !/^[a-f0-9]{40}$/.test(snapshot.sourceTree)) throw new Error('Invalid curated snapshot.');
    args.push('--env', 'DEVPOD_PUBLIC_SNAPSHOT=1', '--mount', `type=bind,source=${join(root, 'PUBLIC-SNAPSHOT.json')},target=/workspace/PUBLIC-SNAPSHOT.json,readonly`);
  }
  for (const [name, path] of [[volumes[0], 'node_modules'], [volumes[1], '.astro']]) args.push('--mount', `type=volume,source=${name},target=/workspace/${path}`);
  for (const path of outputs) {
    mkdirSync(join(root, path), { recursive: true }); assertSafeInput(root, path);
    args.push('--mount', `type=bind,source=${join(root, path)},target=/workspace/${path}`);
  }
  if (target === 'dev') args.push('--publish', '127.0.0.1:4321:4321');
  if (target === 'upload-preview' || target === 'upload-prod') {
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
      if (!env[name]?.trim()) throw new Error(`Missing ${name}.`);
      args.push('--env', name);
    }
    if (!/^[a-f0-9]{40}$/.test(env.DEPLOY_SHA ?? '') || !['true', 'false'].includes(env.DEPLOY_DIRTY ?? 'false')) throw new Error('Invalid deployment revision.');
    const branch = env.PREVIEW_BRANCH;
    if (target === 'upload-prod') {
      if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'kyuby-vault/kyuby.com-public' || env.GITHUB_REF !== 'refs/heads/main'
        || env.DEPLOY_CONFIRM !== 'deploy-kyuby-com') throw new Error('Production uploads are restricted to the confirmed public main workflow.');
    } else if (!/^(local|preview)-[a-z0-9-]+$/.test(branch ?? '') || branch.length > 63) throw new Error('Invalid preview branch.');
    args.push(image, 'npx', '--no-install', 'wrangler', 'pages', 'deploy', 'dist', '--project-name', 'kyuby-com',
      '--branch', target === 'upload-prod' ? 'main' : branch, '--commit-hash', env.DEPLOY_SHA, `--commit-dirty=${env.DEPLOY_DIRTY ?? 'false'}`);
  } else {
    if (!['dev', 'gates', 'check', 'test', 'test-browser', 'build', 'dry-run'].includes(target)) throw new Error('Unknown container target.');
    args.push(image, 'make', '-C', '/workspace', target);
  }
  return args;
}
export function main(target, env = process.env) {
  const root = realpathSync(process.cwd());
  const engine = env.CONTAINER_ENGINE || 'podman';
  if (!['podman', 'docker'].includes(engine)) throw new Error('CONTAINER_ENGINE must be podman or docker.');
  const image = env.DEVPOD_IMAGE || 'localhost/kyuby-devpod';
  assertCopies(root);
  if (target === 'image') {
    if (!existsSync(join(root, '.dockerignore'))) throw new Error('The deny-by-default .dockerignore is required before building.');
    assertSafeInput(root, '.github/workflows/devpod');
    for (const file of ['package.json', 'package-lock.json', '.nvmrc']) assertSafeInput(root, file);
    // The same deny-by-default context file also protects exported public snapshots.
    run(engine, ['build', '--platform', 'linux/amd64', '--file', '.github/workflows/devpod/Containerfile', '--tag', image, root]);
    return;
  }
  if (target === 'clean') {
    if (env.CONFIRM !== 'clean-kyuby-devpod') throw new Error('Use CONFIRM=clean-kyuby-devpod to remove only the two DevPod cache volumes and its dangling images.');
    run(engine, ['volume', 'rm', ...volumes]); // No force: active containers fail closed.
    run(engine, ['image', 'prune', '--force', '--filter', 'label=com.kyuby.devpod=true']);
    console.log('Removed DevPod dependency/codegen caches and labeled dangling images; source and outputs were preserved.');
    return;
  }
  if (target === 'deploy-preview') {
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) if (!env[name]?.trim()) throw new Error(`Missing ${name}.`);
    const branch = previewBranch(run('git', ['branch', '--show-current'], { capture: true }));
    const sha = run('git', ['rev-parse', 'HEAD'], { capture: true });
    const dirty = run('git', ['status', '--porcelain'], { capture: true }) !== '';
    run(engine, containerArgs(root, 'build', env));
    run(engine, containerArgs(root, 'dry-run', env));
    const deployEnv = { ...env, PREVIEW_BRANCH: branch, DEPLOY_SHA: sha, DEPLOY_DIRTY: String(dirty) };
    run(engine, containerArgs(root, 'upload-preview', deployEnv), { env: deployEnv });
    return;
  }
  run(engine, containerArgs(root, target, env), { env });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
