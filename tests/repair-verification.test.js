import { describe, it, expect } from 'test-anywhere';
import assert from 'node:assert/strict';
import { createRepairVerifier } from '../src/index.js';
import { actionsApi } from './fixtures/actions-api.js';

const sha = 'a'.repeat(40);
const request = {
  repo: 'acme/one',
  workflow: 'release.yml',
  runId: 1,
  jobIds: [2],
  changes: [{ kind: 'setting', changed: true, verified: true }],
  timeout: 0,
};
function fixture({
  complete = true,
  finalJobs = [
    {
      id: 3,
      name: 'Publish',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 2,
    },
  ],
} = {}) {
  let requested = false;
  const api = actionsApi({
    conclusion: 'failure',
    routes: {
      'POST /repos/acme/one/actions/runs/1/rerun-failed-jobs': () => {
        requested = true;
        return { status: 201 };
      },
      '/repos/acme/one/actions/runs/1': () => ({
        body: {
          ...api.run,
          head_sha: sha,
          ...(requested && complete
            ? { conclusion: 'success', run_attempt: 2 }
            : {}),
        },
      }),
      '/repos/acme/one/actions/runs/1/attempts/2/jobs': {
        body: {
          jobs: finalJobs,
        },
      },
    },
  });
  api.run.head_sha = sha;
  return api;
}
describe('verified caller-driven repair to CI', () => {
  it('waits for a fresh attempt and returns SHA, conclusion and job evidence', async () => {
    const api = fixture();
    const result = await createRepairVerifier({ rest: api.rest }).verify(
      request
    );
    expect(result.status).toBe('success');
    expect(result.runAttempt).toBe(2);
    expect(result.sha).toBe(sha);
    expect(result.jobs[0].name).toBe('Publish');
    expect(api.calls.filter((call) => call.method === 'POST').length).toBe(1);
  });
  it('does not claim success for an accepted request without a new completed attempt', async () => {
    const api = fixture({ complete: false });
    const result = await createRepairVerifier({ rest: api.rest }).verify(
      request
    );
    expect(result.status).toBe('timeout');
    expect(result.success).toBe(false);
  });
  it('never restarts no-op, unverified or unrelated repairs', async () => {
    const api = fixture();
    const verifier = createRepairVerifier({ rest: api.rest });
    expect(
      (
        await verifier.verify({
          ...request,
          changes: [{ kind: 'setting', changed: false, verified: true }],
        })
      ).status
    ).toBe('skipped');
    await assert.rejects(
      verifier.verify({
        ...request,
        changes: [{ kind: 'setting', changed: true, verified: false }],
      }),
      /verified/
    );
    await assert.rejects(
      verifier.verify({ ...request, workflow: 'unrelated.yml' }),
      /workflow/
    );
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('requires a new revision for workflow changes and leaves dry runs untouched', async () => {
    const api = fixture();
    const verifier = createRepairVerifier({ rest: api.rest });
    await assert.rejects(
      verifier.verify({
        ...request,
        changes: [{ kind: 'workflow', changed: true, verified: true }],
      }),
      /revision/
    );
    expect((await verifier.verify({ ...request, dryRun: true })).status).toBe(
      'dry-run'
    );
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
});

describe('repair evidence boundaries', () => {
  it('rejects nonexistent affected jobs and API authorization errors before requesting CI', async () => {
    const api = fixture();
    await assert.rejects(
      createRepairVerifier({ rest: api.rest }).verify({
        ...request,
        jobIds: [99],
      }),
      /failed job/
    );
    const denied = actionsApi({
      routes: { '/repos/acme/one/actions/runs/1': { status: 403 } },
    });
    await assert.rejects(
      createRepairVerifier({ rest: denied.rest }).verify(request),
      (error) => error.status === 403
    );
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(denied.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('bounds waits with a finite deadline and never treats stale successful jobs as evidence', async () => {
    const api = fixture({ complete: false });
    let time = 0;
    const result = await createRepairVerifier({
      rest: api.rest,
      now: () => time,
      sleep: (ms) => {
        time += ms;
      },
    }).verify({ ...request, timeout: 7, interval: 3 });
    expect(result.status).toBe('timeout');
    expect(time).toBe(7);
    expect(result.jobs.length).toBe(0);
  });
  it('does not report success when completed affected jobs are skipped or missing', async () => {
    for (const jobs of [
      [],
      [{ name: 'Publish', status: 'completed', conclusion: 'skipped' }],
    ]) {
      const api = fixture({ finalJobs: jobs });
      expect(
        (await createRepairVerifier({ rest: api.rest }).verify(request)).status
      ).toBe('failure');
    }
  });
  it('reruns an affected job subset without restarting unrelated failed jobs', async () => {
    let requested = false;
    const api = actionsApi({
      conclusion: 'failure',
      routes: {
        '/repos/acme/one/actions/runs/1/jobs': () => ({
          body: {
            jobs: [
              api.job,
              {
                id: 5,
                name: 'Other',
                status: 'completed',
                conclusion: 'failure',
              },
            ],
          },
        }),
        'POST /repos/acme/one/actions/jobs/2/rerun': () => {
          requested = true;
          return { status: 201 };
        },
        '/repos/acme/one/actions/runs/1': () => ({
          body: { ...api.run, head_sha: sha, run_attempt: requested ? 2 : 1 },
        }),
        '/repos/acme/one/actions/runs/1/attempts/2/jobs': {
          body: {
            jobs: [
              { name: 'Publish', status: 'completed', conclusion: 'success' },
            ],
          },
        },
      },
    });
    const result = await createRepairVerifier({ rest: api.rest }).verify(
      request
    );
    expect(result.jobs[0].conclusion).toBe('success');
    expect(result.conclusion).toBe('failure');
    expect(result.success).toBe(false);
    expect(
      api.calls
        .filter((call) => call.method === 'POST')
        .map((call) => call.path)
    ).toEqual(['/repos/acme/one/actions/jobs/2/rerun']);
  });
});
