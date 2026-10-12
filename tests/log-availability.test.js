import { describe, it, expect } from 'test-anywhere';
import { createRunManager } from '../src/github/runs.js';
import { createSecretHealth } from '../src/secrets/health.js';
import { actionsApi } from './fixtures/actions-api.js';
import { apiCommand } from './fixtures/cli.js';

const now = () => Date.parse('2026-10-11T00:00:00Z');

function scanApi(routes = {}) {
  const api = actionsApi({
    conclusion: 'failure',
    routes: {
      '/orgs/acme/repos': {
        body: ['one', 'two'].map((name) => ({
          full_name: `acme/${name}`,
          default_branch: 'main',
        })),
      },
      '/repos/acme/two/actions/workflows/release.yml/runs': () => ({
        body: {
          workflow_runs: [
            {
              ...api.run,
              id: 3,
              html_url: 'https://github.com/acme/two/actions/runs/3',
            },
          ],
        },
      }),
      '/repos/acme/two/actions/runs/3/jobs': () => ({
        body: { jobs: [{ ...api.job, id: 4 }] },
      }),
      '/repos/acme/two/actions/jobs/4/logs': {
        body: '2026-01-01T00:00:02Z unauthorized',
      },
      ...routes,
    },
  });
  return api;
}

describe('unavailable Actions log evidence', () => {
  for (const status of [404, 410]) {
    it(`keeps organization failure scans running after log HTTP ${status}`, async () => {
      const api = scanApi({
        '/repos/acme/one/actions/jobs/2/logs': { status },
      });
      const result = await createRunManager({ rest: api.rest, now }).failures({
        org: 'acme',
        grep: ['unauthorized'],
      });
      expect(result.length).toBe(2);
      expect(result[0].status).toBe('unknown');
      expect(result[0].reason).toBe(
        status === 410 ? 'logs-expired' : 'logs-unavailable'
      );
      expect(result[0].runId).toBe(1);
      expect(result[1].repository).toBe('acme/two');
      expect(result[1].matches[0].text).toContain('unauthorized');
    });

    it(`classifies expired/deleted secret logs as unknown after HTTP ${status}`, async () => {
      const api = scanApi({
        '/repos/acme/one/actions/jobs/2/logs': { status },
      });
      const result = await createSecretHealth({ rest: api.rest, now }).health(
        'CUSTOM_TOKEN',
        { scope: { org: 'acme' } }
      );
      expect(result.evidence[0].status).toBe('unknown');
      expect(result.evidence[0].reason).toBe(
        status === 410 ? 'logs-expired' : 'logs-unavailable'
      );
      expect(
        result.evidence.some(
          (item) =>
            item.repository === 'acme/two' && item.status === 'auth-failing'
        )
      ).toBe(true);
    });
  }

  it('reports deleted runs as unavailable when their jobs endpoint returns 404', async () => {
    const api = actionsApi({
      routes: { '/repos/acme/one/actions/runs/1/jobs': { status: 404 } },
    });
    const result = await createRunManager({ rest: api.rest }).logs(1, {
      repo: 'acme/one',
    });
    expect(result[0].status).toBe('logs-unavailable');
    expect(result[0].runId).toBe(1);
    expect(result[0].url).toBe(api.run.html_url);
  });

  it('preserves available matches alongside a missing job log', async () => {
    const api = actionsApi({
      routes: {
        '/repos/acme/one/actions/runs/1/jobs': () => ({
          body: { jobs: [api.job, { ...api.job, id: 5 }] },
        }),
        '/repos/acme/one/actions/jobs/2/logs': { status: 410 },
        '/repos/acme/one/actions/jobs/5/logs': { body: 'unauthorized' },
      },
    });
    const result = await createRunManager({ rest: api.rest }).logs(1, {
      repo: 'acme/one',
      grep: ['unauthorized'],
    });
    expect(result[0].status).toBe('logs-expired');
    expect(result[1].text).toBe('unauthorized');
  });
});

describe('recent default-branch workflow evidence', () => {
  it('uses the latest run per workflow and never revives older failures', async () => {
    const api = scanApi({
      '/repos/acme/one/actions/workflows': {
        body: {
          workflows: [
            { id: 7, path: '.github/workflows/release.yml' },
            { id: 8, path: '.github/workflows/check.yml' },
          ],
        },
      },
      '/repos/acme/one/actions/workflows/check.yml/runs': ({ query }) => ({
        body: {
          workflow_runs:
            query.get('branch') === 'main'
              ? [
                  { id: 9, conclusion: 'success' },
                  { id: 8, conclusion: 'failure' },
                ]
              : [],
        },
      }),
    });
    const result = await createRunManager({ rest: api.rest, now }).failures({
      org: 'acme',
    });
    expect(
      result.some((item) => item.repository === 'acme/one' && item.runId === 1)
    ).toBe(true);
    expect(api.calls.some((call) => call.path.includes('/runs/8/'))).toBe(
      false
    );
    expect(
      api.calls
        .filter((call) => call.path.endsWith('/runs'))
        .every(
          (call) =>
            call.query.get('branch') === 'main' && !call.query.has('status')
        )
    ).toBe(true);
  });

  it('skips logs older than the retention window without reading jobs or pinned workflow content', async () => {
    const api = scanApi();
    api.run.created_at = '2026-01-01T00:00:00Z';
    api.run.head_sha = 'old-sha';
    for (const result of [
      await createRunManager({ rest: api.rest, now }).failures({ org: 'acme' }),
      (
        await createSecretHealth({ rest: api.rest, now }).health(
          'CUSTOM_TOKEN',
          { scope: { org: 'acme' } }
        )
      ).evidence,
    ]) {
      expect(result[0].status).toBe('unknown');
      expect(result[0].reason).toBe('logs-expired');
    }
    expect(
      api.calls.some(
        (call) =>
          call.path.endsWith('/jobs') ||
          call.path.endsWith('/logs') ||
          call.query.get('ref') === 'old-sha'
      )
    ).toBe(false);
  });

  it('uses the repository default branch for health and preserves an explicit branch override', async () => {
    const api = actionsApi({
      routes: { '/repos/acme/one': { body: { default_branch: 'trunk' } } },
    });
    const health = createSecretHealth({ rest: api.rest, now });
    await health.health('CUSTOM_TOKEN', { scope: { repo: 'acme/one' } });
    await health.health('CUSTOM_TOKEN', {
      scope: { repo: 'acme/one' },
      branch: 'release',
    });
    expect(
      api.calls
        .filter((call) => call.path.endsWith('/runs'))
        .map((call) => call.query.get('branch'))
    ).toEqual(['trunk', 'release']);
  });

  it('allows a shorter retention window and uses the latest rerun timestamp', async () => {
    const api = scanApi();
    api.run.created_at = '2026-01-01T00:00:00Z';
    api.run.updated_at = '2026-10-01T00:00:00Z';
    const runs = createRunManager({ rest: api.rest, now });
    expect(
      (await runs.failures({ org: 'acme', retentionDays: 7 }))[0].reason
    ).toBe('logs-expired');
    expect(
      (await runs.failures({ org: 'acme', retentionDays: 30 }))[0].matches
        .length
    ).toBe(1);
  });
});

describe('bulk scan reporting', () => {
  it('rejects invalid retention before issuing any requests', async () => {
    for (const retentionDays of [0, -1, NaN, Infinity]) {
      const api = actionsApi();
      for (const inspect of [
        () =>
          createRunManager({ rest: api.rest }).failures({
            org: 'acme',
            retentionDays,
          }),
        () =>
          createSecretHealth({ rest: api.rest }).health('CUSTOM_TOKEN', {
            scope: { org: 'acme' },
            retentionDays,
          }),
      ]) {
        let error;
        try {
          await inspect();
        } catch (failure) {
          error = failure;
        }
        expect(error?.exitCode).toBe(2);
      }
      expect(api.calls.length).toBe(0);
    }
  });

  it('continues to later workflows in the same repository after a run-list error', async () => {
    const api = scanApi({
      '/repos/acme/one/actions/workflows': {
        body: {
          workflows: [
            { path: '.github/workflows/check.yml' },
            { path: '.github/workflows/release.yml' },
          ],
        },
      },
      '/repos/acme/one/actions/workflows/check.yml/runs': { status: 500 },
    });
    const findings = await createRunManager({ rest: api.rest, now }).failures({
      org: 'acme',
    });
    expect(findings[0].error).toContain('500');
    expect(findings[1].repository).toBe('acme/one');
    expect(findings[1].runId).toBe(1);
    expect(findings[2].repository).toBe('acme/two');
  });

  it('forwards retention settings from the CLI and keeps progress out of stdout', async () => {
    const api = scanApi();
    api.run.created_at = new Date(Date.now() - 10 * 86400000).toISOString();
    for (const args of [
      ['runs', 'failures', '--org', 'acme'],
      ['secret', 'health', 'CUSTOM_TOKEN', '--org', 'acme'],
    ]) {
      const result = await apiCommand(
        [...args, '--retention-days', '7', '--json'],
        api
      );
      const parsed = JSON.parse(result.output);
      expect((parsed.unavailableLogs ?? parsed.evidence)[0].reason).toBe(
        'logs-expired'
      );
      expect(result.errors).toContain('2/2 repositories');
    }
  });

  for (const status of [403, 500]) {
    it(`reports repository HTTP ${status}, progress and later results in JSON failure scans`, async () => {
      const api = scanApi({ '/repos/acme/one/actions/workflows': { status } });
      const result = await apiCommand(
        ['runs', 'failures', '--org', 'acme', '--json'],
        api
      );
      const findings = JSON.parse(result.output);
      expect(result.code).toBe(0);
      expect(findings.errors[0].status).toBe('unknown');
      expect(findings.errors[0].error).toContain(String(status));
      expect(findings.matches[0].repository).toBe('acme/two');
      expect(result.errors).toContain('0/2 repositories');
      expect(result.errors).toContain('2/2 repositories');
      expect(result.errors).toContain('1 repository error');
    });

    it(`reports repository HTTP ${status} and continues health scans`, async () => {
      const api = scanApi({
        '/repos/acme/one/contents/.github/workflows': { status },
      });
      const result = await apiCommand(
        ['secret', 'health', 'CUSTOM_TOKEN', '--org', 'acme', '--json'],
        api
      );
      const health = JSON.parse(result.output);
      expect(result.code).toBe(0);
      expect(health.evidence[0].status).toBe('unknown');
      expect(health.evidence[0].error).toContain(String(status));
      expect(
        health.evidence.some((item) => item.repository === 'acme/two')
      ).toBe(true);
      expect(result.errors).toContain('2/2 repositories');
      expect(result.errors).toContain('1 repository error');
    });
  }

  it('catches run-list failures before health classification and proceeds to the next repository', async () => {
    const api = scanApi({
      '/repos/acme/one/actions/workflows/release.yml/runs': { status: 500 },
    });
    const health = await createSecretHealth({ rest: api.rest, now }).health(
      'CUSTOM_TOKEN',
      { scope: { org: 'acme' } }
    );
    expect(health.evidence[0].error).toContain('500');
    expect(health.evidence.some((item) => item.repository === 'acme/two')).toBe(
      true
    );
  });
});
