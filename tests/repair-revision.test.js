import { describe, it, expect } from 'test-anywhere';
import assert from 'node:assert/strict';
import { createRepairVerifier } from '../src/index.js';
import { actionsApi } from './fixtures/actions-api.js';

const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const source = `on: [push, workflow_dispatch]
jobs:
  publish:
    permissions:
      id-token: write
    steps: []
`;
const input = {
  repo: 'acme/one',
  workflow: 'release.yml',
  runId: 1,
  jobIds: [2],
  timeout: 0,
  revision: { ref: 'main', sha: newSha },
  changes: [{ kind: 'workflow', changed: true, verified: true }],
  requiredPermissions: [
    { job: 'publish', permission: 'id-token', level: 'write' },
  ],
};
function fixture({
  oldResponse = false,
  mismatch = false,
  content = source,
  runsAfterDispatch = true,
} = {}) {
  let dispatched = false;
  const fresh = {
    id: 9,
    workflow_id: 7,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    head_sha: mismatch ? oldSha : newSha,
    path: '.github/workflows/release.yml',
    html_url: 'https://github.com/acme/one/actions/runs/9',
  };
  const api = actionsApi({
    conclusion: 'failure',
    source: content,
    routes: {
      '/repos/acme/one/commits/main': { body: { sha: newSha } },
      '/repos/acme/one/actions/workflows/release.yml/runs': () => ({
        body: { workflow_runs: dispatched && runsAfterDispatch ? [fresh] : [] },
      }),
      'POST /repos/acme/one/actions/workflows/release.yml/dispatches': () => {
        dispatched = true;
        return oldResponse ? { status: 204 } : { body: { workflow_run_id: 9 } };
      },
      '/repos/acme/one/actions/runs/9': { body: fresh },
      '/repos/acme/one/actions/runs/9/attempts/1/jobs': {
        body: {
          jobs: [
            {
              id: 20,
              name: 'Publish',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      },
    },
  });
  api.run.head_sha = oldSha;
  return api;
}
describe('workflow revision repair verification', () => {
  for (const oldResponse of [false, true]) {
    it(`dispatches the updated SHA and verifies final jobs (${oldResponse ? '204 discovery' : 'run details'})`, async () => {
      const api = fixture({ oldResponse });
      const result = await createRepairVerifier({ rest: api.rest }).verify(
        input
      );
      expect(result.status).toBe('success');
      expect(result.sha).toBe(newSha);
      const post = api.calls.filter((call) => call.method === 'POST');
      expect(post.length).toBe(1);
      expect(post[0].path).toContain('/workflows/release.yml/dispatches');
      expect(post[0].body.ref).toBe('main');
      expect(
        api.calls
          .find((call) => call.path.includes('/contents/'))
          .query.get('ref')
      ).toBe(newSha);
    });
  }
  it('monitors a caller-started new-revision run without dispatching', async () => {
    const api = fixture({
      content: source.replace('[push, workflow_dispatch]', 'push'),
    });
    const result = await createRepairVerifier({ rest: api.rest }).verify({
      ...input,
      newRunId: 9,
    });
    expect(result.status).toBe('success');
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('reports missing job permissions as a code prerequisite without changing repository defaults', async () => {
    const api = fixture({
      content: source.replace('      id-token: write', '      contents: read'),
    });
    const result = await createRepairVerifier({ rest: api.rest }).verify(input);
    expect(result.status).toBe('prerequisite');
    expect(result.prerequisites[0].job).toBe('publish');
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('reports non-dispatchable code as a prerequisite and rejects stale target refs', async () => {
    const api = fixture({
      content: source.replace('[push, workflow_dispatch]', 'push'),
    });
    const verifier = createRepairVerifier({ rest: api.rest });
    expect((await verifier.verify(input)).status).toBe('prerequisite');
    await assert.rejects(
      verifier.verify({ ...input, revision: { ref: 'main', sha: oldSha } }),
      /updated workflow SHA/
    );
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('refuses a dispatched run at the wrong SHA and times out if dispatch is never observed', async () => {
    const mismatch = fixture({ mismatch: true });
    expect(
      (await createRepairVerifier({ rest: mismatch.rest }).verify(input)).status
    ).toBe('verification-failed');
    const missing = fixture({ oldResponse: true, runsAfterDispatch: false });
    expect(
      (await createRepairVerifier({ rest: missing.rest }).verify(input)).status
    ).toBe('timeout');
  });
});
