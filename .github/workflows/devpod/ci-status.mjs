// Host-only, read-only GitHub checks shared by export and production preflight.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const PRIVATE = 'kyuby-vault/kyuby.com';
const PUBLIC = 'kyuby-vault/kyuby.com-public';
const POLL_MS = 15_000;
const RETRY_MS = [2_000, 5_000, 10_000]; // three retries after the initial request
const pending = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const transient = /rate.?limit|HTTP (429|50[0234])|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN|ENOTFOUND|timed? ?out|timeout|network|connection|TLS handshake|unexpected EOF|temporary failure|dial tcp/i;

export function assertCiRun(run, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || run?.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push'
    || run.status !== 'completed' || run.conclusion !== 'success' || !Number.isSafeInteger(run.check_suite_id)
    || run.check_suite_id <= 0) throw new Error('Exact-SHA main CI must be green.');
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    // Inspect transport diagnostics for classification, but never echo arbitrary CLI output/secrets.
    const detail = `${result.error?.code ?? ''} ${result.error?.message ?? ''} ${result.stderr ?? ''}`;
    throw Object.assign(new Error(transient.test(detail) ? 'transient gh/API error (network or rate limit)' : 'gh/API request failed (check authentication and repository access)'),
      { transient: transient.test(detail) });
  }
  return result.stdout;
}

export function createCiMonitor({ env = process.env, invoke = gh, now = Date.now, wait = ms => sleep(ms), log = console.log } = {}) {
  let current;
  let repository = PRIVATE;
  const details = () => `run id=${current?.id ?? 'unavailable'}; URL=https://github.com/${repository}/actions${current?.id ? `/runs/${current.id}` : ''}; conclusion=${current?.conclusion ?? 'unavailable'}; status=${current?.status ?? 'unavailable'}`;
  const fail = message => { throw new Error(`${message} [${details()}]`); };
  const minutes = env.EXPORT_CI_WAIT_MINUTES ?? '30';
  const waitBudget = () => {
    if (!/^\d+$/.test(minutes) || Number(minutes) > 1440) fail('EXPORT_CI_WAIT_MINUTES must be an integer from 0 to 1440');
    return Number(minutes) * 60_000;
  };
  async function api(path, paginate = false) {
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await invoke(['api', ...(paginate ? ['--paginate', '--slurp'] : []), `repos/${repository}/${path}`]);
        try { return JSON.parse(raw); } catch { fail('gh/API returned invalid JSON'); }
      } catch (error) {
        if (!error.transient || attempt === RETRY_MS.length) fail(error.message);
        log(`CI API retry ${attempt + 1}/3 in ${RETRY_MS[attempt] / 1000}s; ${details()}`);
        await wait(RETRY_MS[attempt]);
      }
    }
  }
  const heartbeat = start => log(`CI wait elapsed=${Math.floor((now() - start) / 1000)}s; ${details()}`);
  async function pause(start, budget, reason) {
    if (now() - start >= budget) fail(`${reason}; wait limit ${minutes} minute(s) reached`);
    await wait(Math.min(POLL_MS, budget - (now() - start)));
  }
  async function failedJobs() {
    const pages = await api(`actions/runs/${current.id}/jobs?filter=latest&per_page=100`, true);
    if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page.jobs))) fail('Invalid CI jobs response');
    const names = pages.flatMap(page => page.jobs).filter(job => job.status === 'completed'
      && !['success', 'skipped'].includes(job.conclusion)).map(job => job.name);
    return names.length ? names.join(', ') : 'none reported';
  }
  async function green(repo, sha, { allowSkippedPreview = false, waitForCreation = false } = {}) {
    repository = repo; current = undefined;
    if (![PRIVATE, PUBLIC].includes(repo) || !/^[a-f0-9]{40}$/.test(sha)) fail('Expected an approved repository and full immutable SHA');
    const start = now(); const budget = waitBudget();
    while (true) {
      const response = await api(`actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=1`);
      if (!Array.isArray(response?.workflow_runs)) fail('Invalid CI runs response');
      const run = response.workflow_runs[0];
      if (!run) {
        current = undefined;
        if (!waitForCreation) fail(`no CI run for ${sha}; push or wait`);
        heartbeat(start); await pause(start, budget, `no CI run for ${sha}; push or wait`); continue;
      }
      // Do not trust query filters alone, or a green run for another branch/event/SHA.
      current = run;
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || run.head_sha !== sha || run.head_branch !== 'main'
        || run.event !== 'push' || !Number.isSafeInteger(run.check_suite_id) || run.check_suite_id <= 0) fail('CI run identity mismatch');
      heartbeat(start);
      if (pending.has(run.status)) { await pause(start, budget, 'CI is still pending'); continue; }
      if (run.status !== 'completed') fail('Unknown CI run status');
      if (run.conclusion !== 'success') fail(`CI failed; failed jobs: ${await failedJobs()}`);
      assertCiRun(run, sha);
      const suite = await api(`check-suites/${run.check_suite_id}`);
      if (suite?.id !== run.check_suite_id || suite.head_sha !== sha || suite.app?.slug !== 'github-actions') fail('exact-SHA GitHub Actions CI check suite identity mismatch');
      if (pending.has(suite.status)) { await pause(start, budget, 'CI check suite is still pending'); continue; }
      if (suite.status !== 'completed' || suite.conclusion !== 'success') fail('exact-SHA GitHub Actions CI check suite must have succeeded');
      const pages = await api(`check-suites/${run.check_suite_id}/check-runs?filter=latest&per_page=100`, true);
      if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page?.check_runs))) fail('Invalid exact-SHA gates check response');
      const checks = pages.flatMap(page => page.check_runs);
      if (checks.some(check => !check) || checks.length !== pages[0]?.total_count || checks.filter(check => check.name === 'gates').length !== 1
        || (!allowSkippedPreview && checks.filter(check => check.name === 'preview-deploy').length !== 1)
        || !checks.every(check => check.head_sha === sha && check.check_suite?.id === run.check_suite_id
          && check.app?.slug === 'github-actions')) fail('exact-SHA gates check identity, count, or pagination mismatch');
      if (checks.some(check => check.status === 'completed' && check.conclusion !== 'success'
        && !(allowSkippedPreview && check.name === 'preview-deploy' && check.conclusion === 'skipped'))) {
        fail(`exact-SHA gates check failed; failed jobs: ${checks.filter(check => check.conclusion !== 'success' && check.conclusion !== 'skipped').map(check => check.name).join(', ')}`);
      }
      if (checks.some(check => pending.has(check.status))) { await pause(start, budget, 'exact-SHA gates check is still pending'); continue; }
      if (!checks.every(check => check.status === 'completed')) fail('Unknown exact-SHA gates check status');
      log(`CI verified for ${sha}; ${details()}`);
      return run;
    }
  }
  async function preview(sha) {
    log(`Public commit: ${sha}`);
    await green(PUBLIC, sha, { waitForCreation: true });
    const start = now(); const budget = waitBudget();
    while (true) {
      const pages = await api(`deployments?sha=${sha}&environment=test&per_page=100`, true);
      if (!Array.isArray(pages) || !pages.every(Array.isArray)) fail('Invalid preview deployments response');
      const deployment = pages.flat().filter(item => item.sha === sha && item.environment === 'test'
        && item.production_environment !== true && Number.isSafeInteger(item.id)).sort((a, b) => b.id - a.id)[0];
      if (deployment) {
        const statuses = await api(`deployments/${deployment.id}/statuses?per_page=1`);
        if (!Array.isArray(statuses)) fail('Invalid preview status response');
        const status = statuses[0];
        if (['failure', 'error', 'inactive'].includes(status?.state)) fail(`Latest preview deployment ${deployment.id} is ${status.state}`);
        if (status?.state === 'success') {
          if (!/^https:\/\/[a-z0-9-]+\.kyuby-com\.pages\.dev\/?$/.test(status.environment_url ?? '')) fail('Preview succeeded but has no trusted Pages environment URL');
          log(`Public preview URL: ${status.environment_url}`);
          return status.environment_url;
        }
      }
      heartbeat(start); await pause(start, budget, `Preview URL not yet available for ${sha} (export already pushed; do not re-export)`);
    }
  }
  return { green, preview };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const monitor = createCiMonitor();
    if (process.argv[2] === 'private') await monitor.green(PRIVATE, process.argv[3], { allowSkippedPreview: true });
    else if (process.argv[2] === 'preview') await monitor.preview(process.argv[3]);
    else throw new Error('Use private <sha> or preview <sha>.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
