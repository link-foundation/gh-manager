import { describe, it } from 'test-anywhere';
import assert from 'node:assert/strict';
import { repairRepository } from '../src/doctor/repair.js';
import { jobRecoveryApi, recoveryJob } from './fixtures/job-recovery-api.js';

describe('doctor causal job freshness', () => {
  for (const [description, update] of [
    ['a new active attempt', { run_attempt: 2, status: 'in_progress' }],
    ['a replaced attempt', { run_attempt: 2 }],
    ['a changed revision', { head_sha: 'b'.repeat(40) }],
  ]) {
    it(`refuses ${description} observed after job selection`, async () => {
      const api = jobRecoveryApi();
      const entry = {
        repository: 'acme/one',
        errors: [],
        reruns: [],
        findings: [
          {
            resolved: true,
            result: { changed: true },
            evidence: [{ kind: 'log', runId: 1, jobId: 2, job: 'Publish' }],
          },
        ],
      };
      await repairRepository(entry, {
        rerun: true,
        gateway: () => ({}),
        rest: api.rest,
        runs: {
          get: async () => ({ ...api.run }),
          jobs: async () => {
            Object.assign(api.run, update);
            return [recoveryJob(2, 'Publish')];
          },
        },
      });
      assert.equal(entry.errors[0].status, 'infrastructure-unavailable');
      assert.equal(entry.errors[0].reason, 'run-changed-before-rerun');
      assert.equal(entry.reruns.length, 0);
      assert.ok(api.calls.every((call) => call.method === 'GET'));
    });
  }
});
