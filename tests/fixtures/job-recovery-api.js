import { actionsApi } from './actions-api.js';
import { createRunManager } from '../../src/github/runs.js';

export const recoverySha = 'a'.repeat(40);
export const recoveryInput = {
  repo: 'acme/one',
  workflow: 'release.yml',
  runId: 1,
  jobIds: [2],
  changes: [{ kind: 'setting', changed: true, verified: true }],
  timeout: 0,
};
export const recoveryBase = '/repos/acme/one';
const base = recoveryBase;
const runUrl = 'https://github.com/acme/one/actions/runs/1';

export const recoveryManager = (api, extra = {}) =>
  createRunManager({ rest: api.rest, sleep: () => {}, ...extra });

export function recoveryJob(id, name, attempt = 1, conclusion = 'failure') {
  return {
    id,
    name,
    run_id: 1,
    run_attempt: attempt,
    head_sha: recoverySha,
    run_url: `https://api.github.com${base}/actions/runs/1`,
    html_url: `${runUrl}/job/${id}`,
    status: 'completed',
    conclusion,
    steps: [],
  };
}

export function recoveryCheck(job, suite = 7) {
  return {
    id: job.id + 1000,
    name: job.name,
    head_sha: job.head_sha,
    check_suite: { id: suite },
    details_url: job.html_url,
    status: job.status,
    conclusion: job.conclusion,
  };
}

export function jobRecoveryApi({
  jobs = [recoveryJob(2, 'Publish')],
  mutateChecks,
  listStatus = 502,
  routes = {},
} = {}) {
  let checks = jobs.map((job) => recoveryCheck(job));
  if (mutateChecks) {
    checks = mutateChecks(checks);
  }
  const api = actionsApi({
    conclusion: 'failure',
    routes: {
      [`${base}/actions/runs/1/jobs`]: { status: listStatus },
      [`${base}/actions/runs/1/attempts/1/jobs`]: { status: listStatus },
      [`${base}/commits/${recoverySha}/check-runs`]: {
        body: { total_count: checks.length, check_runs: checks },
      },
      ...Object.fromEntries(
        jobs.map((job) => [`${base}/actions/jobs/${job.id}`, { body: job }])
      ),
      ...routes,
    },
  });
  Object.assign(api.run, { head_sha: recoverySha, check_suite_id: 7 });
  return { ...api, jobs, checks };
}
