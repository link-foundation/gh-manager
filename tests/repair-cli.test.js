import { describe, it, expect } from 'test-anywhere';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiCommand } from './fixtures/cli.js';
import { actionsApi } from './fixtures/actions-api.js';

const evidence = {
  repo: 'acme/one',
  workflow: 'release.yml',
  runId: 1,
  jobIds: [2],
  changes: [{ kind: 'setting', changed: true, verified: true }],
  timeout: 0,
};
async function command(input, api, flags = []) {
  const folder = mkdtempSync(join(tmpdir(), 'repair-cli-'));
  const filename = join(folder, 'repair.json');
  writeFileSync(filename, JSON.stringify(input));
  try {
    return await apiCommand(
      ['repair', 'verify', filename, '--json', ...flags],
      api
    );
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
}
describe('repair verification CLI', () => {
  it('prints final evidence and nonzero status for an unobserved rerun', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      routes: {
        'POST /repos/acme/one/actions/runs/1/rerun-failed-jobs': {
          status: 201,
        },
      },
    });
    api.run.head_sha = 'a'.repeat(40);
    const result = await command(evidence, api);
    expect(result.code).toBe(6);
    expect(JSON.parse(result.output).status).toBe('timeout');
    expect(JSON.parse(result.output).runAttempt).toBe(1);
  });
  it('keeps no-op and dry-run requests free of CI writes', async () => {
    const api = actionsApi({ conclusion: 'failure' });
    api.run.head_sha = 'a'.repeat(40);
    const dry = await command(evidence, api, ['--dry-run']);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.output).status).toBe('dry-run');
    const noop = await command(
      {
        ...evidence,
        changes: [{ kind: 'setting', changed: false, verified: true }],
      },
      api
    );
    expect(JSON.parse(noop.output).status).toBe('skipped');
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
    expect((await command({ ...evidence, changes: [] }, api)).code).toBe(2);
  });
});
