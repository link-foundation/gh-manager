import { describe, it, expect } from 'test-anywhere';
import { apiCommand } from './fixtures/cli.js';
import { actionsApi } from './fixtures/actions-api.js';

describe('compact organization failure output', () => {
  it('separates matched failures, unavailable counts and repository errors', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      routes: {
        '/orgs/acme/repos': {
          body: ['one', 'two', 'three'].map((name) => ({
            full_name: `acme/${name}`,
            default_branch: 'main',
          })),
        },
        '/repos/acme/one/actions/runs/1/jobs': () => ({
          body: { jobs: [api.job, { ...api.job, id: 3 }] },
        }),
        '/repos/acme/one/actions/jobs/3/logs': { status: 404 },
        '/repos/acme/two/actions/runs/1/jobs': { status: 410 },
        '/repos/acme/three/actions/workflows': { status: 500 },
      },
    });
    const result = await apiCommand(
      ['runs', 'failures', '--org', 'acme', '--grep', 'unauthorized', '--json'],
      api
    );
    const report = JSON.parse(result.output);
    expect(report.matches.length).toBe(1);
    expect(report.matches[0].status).toBe('failure');
    expect(report.matches[0].matches[0].text).toContain('unauthorized');
    expect(report.unavailableLogs).toEqual([
      { repository: 'acme/one', reason: 'logs-unavailable', count: 1 },
      { repository: 'acme/two', reason: 'logs-expired', count: 1 },
    ]);
    expect(report.errors[0].repository).toBe('acme/three');
    expect(report.repositories).toEqual([
      { repository: 'acme/one', matches: 1, unavailableLogs: 1, errors: 0 },
      { repository: 'acme/two', matches: 0, unavailableLogs: 1, errors: 0 },
      { repository: 'acme/three', matches: 0, unavailableLogs: 0, errors: 1 },
    ]);
  });

  it('counts each missing job and reports empty repositories without null matches', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      routes: {
        '/orgs/acme/repos': {
          body: [{ full_name: 'acme/one', default_branch: 'main' }],
        },
        '/repos/acme/one/actions/runs/1/jobs': () => ({
          body: {
            jobs: Array.from({ length: 20 }, (_, i) => ({
              ...api.job,
              id: i + 10,
            })),
          },
        }),
      },
    });
    const result = await apiCommand(
      ['runs', 'failures', '--org', 'acme', '--json'],
      api
    );
    const report = JSON.parse(result.output);
    expect(report.matches).toEqual([]);
    expect(report.unavailableLogs.length).toBe(1);
    expect(report.unavailableLogs[0].count).toBe(20);
    expect(result.output.length < 1000).toBe(true);
  });
});
