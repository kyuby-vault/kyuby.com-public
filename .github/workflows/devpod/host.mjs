import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './invoke.mjs';
import { createCiMonitor } from './ci-status.mjs';
export { assertCiRun } from './ci-status.mjs';

const mirror = 'kyuby-vault/kyuby.com-public';
export function hostBash() {
  if (process.platform !== 'win32') return 'bash';
  // Windows' bash.exe may launch WSL. Resolve Git Bash from the installed Git
  // distribution so export keeps the host's Git, Node, gh and credential stores.
  const gitExec = run('git', ['--exec-path'], { capture: true });
  const bash = resolve(gitExec, '../../..', 'bin/bash.exe');
  if (!existsSync(bash)) throw new Error('Git Bash is required for host export; install Git for Windows.');
  return bash;
}
export function assertHost(env = process.env) {
  if (env.KYUBY_DEVPOD === '1') throw new Error('Git, export, dispatch and credential lifecycle commands are host-only.');
}
export function assertProductionLocal(branch, status, env) {
  if (branch !== 'main' || status.trim()) throw new Error('Production dispatch requires clean private main, including untracked files.');
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) if (!env[name]?.trim()) throw new Error(`Missing ${name}.`);
}
export function dispatchArgs(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Production requires an immutable public main SHA.');
  return ['workflow', 'run', 'deploy-prod.yml', '-R', mirror, '--ref', 'main', '-f', `ref=${sha}`, '-f', 'confirm=deploy-kyuby-com'];
}
export function mintReady(path) {
  if (!existsSync(path) || !readFileSync(path, 'utf8').trim()) throw new Error('Paste a master token into .credentials/master.txt first.');
}
export async function main(command, env = process.env) {
  assertHost(env);
  if (command === 'mint-keys-renew') {
    mintReady('.credentials/master.txt');
    run(process.execPath, ['.credentials/cloudflare-mint.mjs', '--mint']);
    console.log('Next: update GitHub environment secrets, then delete .credentials/master.txt. Tokens were not mounted or forwarded to a container.');
    return;
  }
  if (command === 'export-public') { run(hostBash(), ['scripts/export-public.sh', '--publish']); return; }
  if (!['deploy-prod', 'prod-check'].includes(command)) throw new Error('Unknown host target.');
  const git = (args) => run('git', args, { capture: true });
  assertProductionLocal(git(['branch', '--show-current']), git(['status', '--porcelain', '--untracked-files=all']), env);
  // This host script checks private origin, fresh remote HEAD equality,
  // exact-SHA CI run/suite/checks, and the curated public snapshot provenance.
  run(hostBash(), ['scripts/export-public.sh', '--assert-synced']);
  const sha = git(['-C', '.export-tmp/kyuby.com-public', 'rev-parse', 'refs/remotes/origin/main']);
  await createCiMonitor({ env }).green(mirror, sha);
  run(process.execPath, ['scripts/deployment.mjs', 'assert-prod-protection']);
  if (command === 'prod-check') { console.log(`Production preflight passed for ${sha}; no workflow dispatched.`); return; }
  run('gh', dispatchArgs(sha));
  console.log('Production workflow dispatched for the verified public SHA; the prod environment still requires owner approval.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
