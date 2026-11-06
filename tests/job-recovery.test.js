import { describe, it } from 'test-anywhere';
import assert from 'node:assert/strict';
import { createRunManager, createRepairVerifier } from '../src/index.js';
import {
  jobRecoveryApi,
  recoveryJob,
  recoveryCheck,
  recoverySha,
} from './fixtures/job-recovery-api.js';

const base = '/repos/acme/one';
const manager = (api, extra = {}) =>
  createRunManager({ rest: api.rest, sleep: () => {}, ...extra });
const input = {
  repo: 'acme/one',
  workflow: 'release.yml',
  runId: 1,
  jobIds: [2],
  changes: [{ kind: 'setting', changed: true, verified: true }],
  timeout: 0,
};

describe('job-list infrastructure recovery', () => {
  it('bounds 502 retries and recovers verified individual jobs with provenance', async () => {
    const api = jobRecoveryApi();
    const sleeps = [];
    const jobs = await manager(api, { sleep: (ms) => sleeps.push(ms) }).jobs(
      'acme/one',
      1
    );
    assert.equal(
      api.calls.filter((c) => c.path.endsWith('/runs/1/jobs')).length,
      3
    );
    assert.deepEqual(sleeps, [250, 500]);
    assert.equal(jobs[0].id, 2);
    assert.equal(jobs[0].run_attempt, 1);
    assert.equal(jobs[0].head_sha, recoverySha);
    assert.equal(jobs[0].discovery.source, 'check-runs');
    assert.equal(jobs[0].discovery.checkRunId, 1002);
  });
  it('returns normally when a bounded retry succeeds', async () => {
    let calls = 0;
    const api = jobRecoveryApi({
      routes: {
        [`${base}/actions/runs/1/jobs`]: () =>
          ++calls < 3
            ? { status: 503 }
            : { body: { jobs: [recoveryJob(2, 'Publish')] } },
      },
    });
    assert.equal((await manager(api).jobs('acme/one', 1))[0].id, 2);
    assert.equal(calls, 3);
    assert.equal(
      api.calls.some((c) => c.path.includes('/check-runs')),
      false
    );
  });
  it('never retries authorization errors or starts fallback for them', async () => {
    const api = jobRecoveryApi({ listStatus: 403 });
    await assert.rejects(
      manager(api).jobs('acme/one', 1),
      (e) => e.status === 403
    );
    assert.equal(api.calls.length, 1);
  });
  it('excludes unrelated same-SHA runs and chooses the latest identity for each job', async () => {
    const old = recoveryJob(2, 'Publish');
    const fresh = recoveryJob(20, 'Publish', 2, 'success');
    const api = jobRecoveryApi({
      jobs: [old, fresh],
      mutateChecks: (checks) => [
        recoveryCheck(
          {
            ...recoveryJob(88, 'Other'),
            html_url: 'https://github.com/acme/one/actions/runs/9/job/88',
          },
          99
        ),
        ...checks,
      ],
    });
    api.run.run_attempt = 2;
    assert.deepEqual(
      (await manager(api).jobs('acme/one', 1)).map((j) => j.id),
      [20]
    );
    assert.equal(
      api.calls.some((c) => c.path.endsWith('/jobs/88')),
      false
    );
  });
  it('uses the same fallback for attempt-scoped discovery', async () => {
    const api = jobRecoveryApi({
      jobs: [recoveryJob(2, 'Publish'), recoveryJob(4, 'Other', 2)],
    });
    api.run.run_attempt = 2;
    const jobs = await manager(api).jobs('acme/one', 1, { attempt: 1 });
    assert.deepEqual(
      jobs.map((j) => j.id),
      [2]
    );
  });
  for (const [description, options] of [
    ['missing checks', { mutateChecks: () => [] }],
    [
      'wrong repository URL',
      {
        mutateChecks: (cs) =>
          cs.map((c) => ({
            ...c,
            details_url: c.details_url.replace('/acme/one/', '/evil/one/'),
          })),
      },
    ],
    [
      'misleading URL suffix',
      {
        mutateChecks: (cs) =>
          cs.map((c) => ({ ...c, details_url: `${c.details_url}/extra` })),
      },
    ],
    [
      'unreadable individual job',
      { routes: { [`${base}/actions/jobs/2`]: { status: 404 } } },
    ],
    [
      'wrong individual run',
      {
        routes: {
          [`${base}/actions/jobs/2`]: {
            body: { ...recoveryJob(2, 'Publish'), run_id: 9 },
          },
        },
      },
    ],
    [
      'wrong individual SHA',
      {
        routes: {
          [`${base}/actions/jobs/2`]: {
            body: { ...recoveryJob(2, 'Publish'), head_sha: 'b'.repeat(40) },
          },
        },
      },
    ],
    ['future attempt', { jobs: [recoveryJob(2, 'Publish', 2)] }],
    [
      'ambiguous job names',
      { jobs: [recoveryJob(2, 'Publish'), recoveryJob(3, 'Publish')] },
    ],
    [
      'incomplete check inventory',
      {
        routes: {
          [`${base}/commits/${recoverySha}/check-runs`]: {
            body: { total_count: 2, check_runs: [] },
          },
        },
      },
    ],
  ]) {
    it(`reports infrastructure-unavailable for ${description} without writes`, async () => {
      const api = jobRecoveryApi(options);
      await assert.rejects(manager(api).jobs('acme/one', 1), (error) => {
        assert.equal(error.name, 'JobsUnavailableError');
        assert.equal(error.evidence.status, 'infrastructure-unavailable');
        assert.equal(error.evidence.runUrl, api.run.html_url);
        assert.ok(error.evidence.nextAction);
        return true;
      });
      assert.ok(api.calls.every((c) => c.method === 'GET'));
    });
  }
  it('keeps unavailable discovery explicit in log and repair results', async () => {
    const api = jobRecoveryApi({ mutateChecks: () => [] });
    const logs = await manager(api).logs(1, { repo: 'acme/one' });
    assert.equal(logs[0].status, 'infrastructure-unavailable');
    const result = await createRepairVerifier({
      rest: api.rest,
      sleep: () => {},
    }).verify(input);
    assert.equal(result.status, 'infrastructure-unavailable');
    assert.equal(result.success, false);
    assert.ok(result.nextAction);
    assert.ok(api.calls.every((c) => c.method === 'GET'));
  });
  it('retains exact job and attempt provenance in log matches', async () => {
    const api = jobRecoveryApi();
    const logs = await manager(api).logs(1, {
      repo: 'acme/one',
      failedOnly: true,
    });
    assert.equal(logs[0].jobAttempt, 1);
    assert.equal(logs[0].sha, recoverySha);
    assert.equal(logs[0].source, 'job-log');
  });
});

describe('targeted recovery across attempts', () => {
  it('refreshes both caller-stale and newly replaced job IDs without rerunning unrelated failures', async () => {
    let attempt = 2;
    const jobsAt = (n) => [
      recoveryJob(n * 10, 'Java', n, n > 2 ? 'success' : 'failure'),
      recoveryJob(n * 10 + 1, 'Kotlin', n, n > 3 ? 'success' : 'failure'),
      recoveryJob(n * 10 + 2, 'Other', n),
    ];
    const api = jobRecoveryApi({
      jobs: [recoveryJob(2, 'Java'), recoveryJob(3, 'Kotlin')],
      routes: {
        [`${base}/actions/runs/1`]: () => ({
          body: { ...api.run, run_attempt: attempt },
        }),
        [`${base}/commits/${recoverySha}/check-runs`]: () => ({
          body: {
            total_count: 3,
            check_runs: jobsAt(attempt).map((j) => recoveryCheck(j)),
          },
        }),
        ...Object.fromEntries(
          [2, 3, 4].flatMap((n) => [
            [`${base}/actions/runs/1/attempts/${n}/jobs`, { status: 502 }],
            ...jobsAt(n).map((j) => [
              `${base}/actions/jobs/${j.id}`,
              { body: j },
            ]),
          ])
        ),
        [`POST ${base}/actions/jobs/20/rerun`]: () => {
          attempt = 3;
          return { status: 201 };
        },
        [`POST ${base}/actions/jobs/31/rerun`]: () => {
          attempt = 4;
          return { status: 201 };
        },
      },
    });
    const result = await createRepairVerifier({
      rest: api.rest,
      sleep: () => {},
    }).verify({
      ...input,
      jobIds: [2, 3],
      timeout: 10000,
    });
    assert.equal(result.attempts.length, 2);
    assert.equal(result.runAttempt, 4);
    assert.equal(result.success, false); // The unrelated failure remains visible.
    assert.deepEqual(
      api.calls.filter((c) => c.method === 'POST').map((c) => c.path),
      [`${base}/actions/jobs/20/rerun`, `${base}/actions/jobs/31/rerun`]
    );
    assert.ok(result.jobs.every((j) => j.runAttempt === 4));
  });
  it('waits for an already active attempt before selecting jobs', async () => {
    let active = true;
    const api = jobRecoveryApi({
      routes: {
        [`${base}/actions/runs/1`]: () => ({
          body: { ...api.run, status: active ? 'in_progress' : 'completed' },
        }),
      },
    });
    const result = await createRepairVerifier({
      rest: api.rest,
      sleep: () => {
        active = false;
      },
    }).verify({
      ...input,
      dryRun: true,
      timeout: 10000,
    });
    assert.equal(result.status, 'dry-run');
    assert.ok(api.calls.every((c) => c.method === 'GET'));
  });
  it('returns an active-attempt timeout without inspecting stale jobs or writing', async () => {
    const api = jobRecoveryApi();
    api.run.status = 'in_progress';
    const result = await createRepairVerifier({ rest: api.rest }).verify(input);
    assert.equal(result.status, 'timeout');
    assert.equal(result.reason, 'active-attempt');
    assert.equal(api.calls.length, 1);
  });
});
