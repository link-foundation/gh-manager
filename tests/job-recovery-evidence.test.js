import { describe, it } from 'test-anywhere';
import assert from 'node:assert/strict';
import { createRepairVerifier } from '../src/index.js';
import {
  jobRecoveryApi,
  recoveryJob,
  recoveryCheck,
  recoverySha,
  recoveryInput as input,
  recoveryBase as base,
  recoveryManager as manager,
} from './fixtures/job-recovery-api.js';

describe('fallback evidence completeness and races', () => {
  it('paginates all source checks before recovering only the exact run', async () => {
    const others = Array.from({ length: 100 }, (_, i) =>
      recoveryCheck(
        {
          ...recoveryJob(i + 100, `Other ${i}`),
          html_url: `https://github.com/acme/one/actions/runs/9/job/${i + 100}`,
        },
        99
      )
    );
    const api = jobRecoveryApi({
      routes: {
        [`${base}/commits/${recoverySha}/check-runs`]: ({ query }) => ({
          body: {
            total_count: 101,
            check_runs:
              query.get('page') === '1'
                ? others
                : [recoveryCheck(recoveryJob(2, 'Publish'))],
          },
        }),
      },
    });
    assert.deepEqual(
      (await manager(api).jobs('acme/one', 1)).map((j) => j.id),
      [2]
    );
    const checks = api.calls.filter((c) => c.path.endsWith('/check-runs'));
    assert.deepEqual(
      checks.map((c) => c.query.get('page')),
      ['1', '2']
    );
    assert.ok(checks.every((c) => c.query.get('filter') === 'all'));
    assert.equal(
      api.calls.filter((c) => /\/actions\/jobs\/\d+$/.test(c.path)).length,
      1
    );
  });
  it('discards partial job-list pages before falling back', async () => {
    const api = jobRecoveryApi({
      routes: {
        [`${base}/actions/runs/1/jobs`]: ({ query }) =>
          query.get('page') === '1'
            ? {
                body: {
                  jobs: Array.from({ length: 100 }, (_, i) => ({
                    id: i + 50,
                    name: 'Wrong',
                  })),
                },
              }
            : { status: 502 },
      },
    });
    const jobs = await manager(api).jobs('acme/one', 1);
    assert.deepEqual(
      jobs.map((j) => j.id),
      [2]
    );
    assert.equal(
      api.calls.filter((c) => c.path.endsWith('/runs/1/jobs')).length,
      6
    );
  });
  for (const [description, update] of [
    ['missing run SHA', { head_sha: null }],
    ['missing suite identity', { check_suite_id: null }],
    ['missing attempt', { run_attempt: null }],
  ]) {
    it(`refuses ${description}`, async () => {
      const api = jobRecoveryApi();
      Object.assign(api.run, update);
      await assert.rejects(
        manager(api).jobs('acme/one', 1),
        (e) => e.evidence?.reason === 'incomplete-run-evidence'
      );
    });
  }
  it('refuses evidence if the run changes during discovery', async () => {
    let reads = 0;
    const api = jobRecoveryApi({
      routes: {
        [`${base}/actions/runs/1`]: () => ({
          body: { ...api.run, run_attempt: ++reads > 1 ? 2 : 1 },
        }),
      },
    });
    await assert.rejects(
      manager(api).jobs('acme/one', 1),
      (e) => e.evidence?.reason === 'run-changed-during-discovery'
    );
  });
  it('rejects mismatched individual and check status', async () => {
    const api = jobRecoveryApi({
      mutateChecks: (cs) => cs.map((c) => ({ ...c, conclusion: 'success' })),
    });
    await assert.rejects(
      manager(api).jobs('acme/one', 1),
      (e) => e.evidence?.reason === 'individual-job-provenance-mismatch'
    );
  });
  it('does not use an older successful log as the current failed job evidence', async () => {
    const api = jobRecoveryApi({
      jobs: [
        recoveryJob(2, 'Publish', 1, 'success'),
        recoveryJob(20, 'Publish', 2),
      ],
      routes: {
        [`${base}/actions/jobs/20/logs`]: { body: 'current failure' },
      },
    });
    api.run.run_attempt = 2;
    const logs = await manager(api).logs(1, {
      repo: 'acme/one',
      failedOnly: true,
    });
    assert.equal(logs[0].jobId, 20);
    assert.equal(logs[0].jobAttempt, 2);
    assert.equal(logs[0].text, 'current failure');
    assert.equal(api.calls.filter((c) => c.path.endsWith('/logs')).length, 1);
    assert.equal(
      api.calls.some((c) => c.path.includes('/attempts/')),
      false
    );
  });
  it('never retries a failed mutation or falls back to a wider rerun', async () => {
    const api = jobRecoveryApi({
      routes: { [`POST ${base}/actions/jobs/2/rerun`]: { status: 502 } },
    });
    await assert.rejects(
      createRepairVerifier({ rest: api.rest, sleep: () => {} }).verify(input),
      (e) => e.status === 502
    );
    assert.deepEqual(
      api.calls.filter((c) => c.method === 'POST').map((c) => c.path),
      [`${base}/actions/jobs/2/rerun`]
    );
  });
  it('skips a selected stale identity that already succeeded in the current attempt', async () => {
    const api = jobRecoveryApi({
      jobs: [
        recoveryJob(2, 'Publish'),
        recoveryJob(20, 'Publish', 2, 'success'),
        recoveryJob(30, 'Other', 2),
      ],
    });
    api.run.run_attempt = 2;
    const result = await createRepairVerifier({
      rest: api.rest,
      sleep: () => {},
    }).verify(input);
    assert.equal(result.reason, 'jobs-no-longer-failed');
    assert.ok(api.calls.every((c) => c.method === 'GET'));
  });
});
