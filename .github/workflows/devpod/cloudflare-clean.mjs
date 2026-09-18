import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertHost } from './host.mjs';

/**
 * @param {Array<Record<string, any>>} deployments
 * @param {Array<Record<string, any>>} workers
 * @param {{now?: number, staleDays?: number, workerAllowlist?: string[]}} options
 */
export function cleanupCandidates(deployments, workers, { now = Date.now(), staleDays = 30, workerAllowlist = [] } = {}) {
  if (!Number.isInteger(staleDays) || staleDays < 7) throw new Error('STALE_DAYS must be an integer of at least 7.');
  if (workerAllowlist.some(name => !/^kyuby-com-preview-[a-z0-9-]+$/.test(name))) throw new Error('Only explicitly listed kyuby-com-preview-* Workers may be deleted. Never site or model-host Workers.');
  return {
    deployments: deployments.filter(d => d.environment === 'preview' && /^(local|preview)-/.test(d.deployment_trigger?.metadata?.branch ?? '')
      && ['success', 'failure', 'canceled'].includes(d.latest_stage?.status)
      && Number.isFinite(Date.parse(d.created_on)) && now - Date.parse(d.created_on) >= staleDays * 86400_000),
    workers: workers.filter(w => workerAllowlist.includes(w.id)),
  };
}
export async function main(env = process.env) {
  assertHost(env);
  if (!env.CLOUDFLARE_API_TOKEN?.trim() || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw new Error('Set scoped CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID on the host.');
  const api = async (path, method = 'GET') => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/${path}`, {
      method, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} failed (${response.status}); cleanup stopped.`);
    return data;
  };
  const deployments = [];
  for (let page = 1; ; page++) {
    const data = await api(`pages/projects/kyuby-com/deployments?per_page=100&page=${page}`);
    if (!Array.isArray(data.result)) throw new Error('Invalid deployment inventory.');
    deployments.push(...data.result);
    if (data.result.length < 100) break;
    if (page >= 100) throw new Error('Inventory pagination exceeded safe bounds.');
  }
  const workers = (await api('workers/scripts')).result;
  const options = { staleDays: Number(env.STALE_DAYS || 30), workerAllowlist: (env.CLEAN_WORKERS || '').split(',').filter(Boolean) };
  const candidates = cleanupCandidates(deployments, workers, options);
  console.log(JSON.stringify({ mode: env.CONFIRM === 'delete-kyuby-previews' ? 'delete' : 'plan',
    deployments: candidates.deployments.map(d => ({ id: d.id, branch: d.deployment_trigger.metadata.branch, status: d.latest_stage.status })),
    workers: candidates.workers.map(w => w.id) }, null, 2));
  if (env.CONFIRM !== 'delete-kyuby-previews') { console.log('Review this plan. CONFIRM=delete-kyuby-previews authorizes only these candidates; CLEAN_WORKERS explicitly asserts those temporary Workers are unused.'); return; }
  for (const deployment of candidates.deployments) {
    const fresh = (await api(`pages/projects/kyuby-com/deployments/${encodeURIComponent(deployment.id)}`)).result;
    if (cleanupCandidates([fresh], [], options).deployments.length !== 1) throw new Error('Deployment eligibility changed; cleanup stopped.');
    await api(`pages/projects/kyuby-com/deployments/${encodeURIComponent(deployment.id)}`, 'DELETE'); // No force: active aliases fail closed.
  }
  for (const worker of candidates.workers) await api(`workers/scripts/${encodeURIComponent(worker.id)}`, 'DELETE');
  console.log('Deleted only the listed temporary candidates. Remote deletion is not automatically recoverable; redeploy from source if needed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
