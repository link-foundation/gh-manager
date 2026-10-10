import { describe, it, expect } from 'test-anywhere';
import { createRepoManager } from '../src/github/repos.js';
import { createRunManager } from '../src/github/runs.js';
import { actionsApi, repository } from './fixtures/actions-api.js';

describe('repository discovery', () => {
  it('paginates, filters forks/archived by default, and supports user listing', async () => {
    const api = actionsApi({
      routes: {
        '/orgs/acme/repos': ({ query }) => ({
          body:
            query.get('page') === '1'
              ? Array.from({ length: 100 }, (_, id) => ({
                  id,
                  name: `r${id}`,
                  archived: id > 0,
                  fork: false,
                }))
              : [{ name: 'fork', fork: true }],
        }),
        '/users/alice/repos': { body: [{ name: 'personal', archived: true }] },
      },
    });
    const repos = createRepoManager({ rest: api.rest });
    expect(
      (await repos.list({ org: 'acme' })).map((repo) => repo.name)
    ).toEqual(['r0']);
    expect(
      (
        await repos.list({
          org: 'acme',
          includeArchived: true,
          includeForks: true,
        })
      ).length
    ).toBe(101);
    expect(
      (await repos.list({ user: 'alice', includeArchived: true }))[0].name
    ).toBe('personal');
  });
  it('reads matching blob contents and traverses a truncated tree', async () => {
    const api = actionsApi({
      routes: {
        '/repos/acme/one/git/trees/main': ({ query }) => ({
          body: query.has('recursive')
            ? { truncated: true, tree: [] }
            : { tree: [{ path: 'nested', type: 'tree', sha: 'sub' }] },
        }),
        '/repos/acme/one/git/trees/sub': {
          body: {
            tree: [{ path: 'manifest.json', type: 'blob', sha: 'blob' }],
          },
        },
        '/repos/acme/one/git/blobs/blob': {
          body: {
            encoding: 'base64',
            content: Buffer.from('{"name":"demo"}').toString('base64'),
          },
        },
      },
    });
    const files = await createRepoManager({ rest: api.rest }).files(
      repository,
      { match: ['**/manifest.json'], content: true }
    );
    expect(files).toEqual([
      { path: 'nested/manifest.json', sha: 'blob', content: '{"name":"demo"}' },
    ]);
  });
});

describe('Actions run discovery', () => {
  it('lists runs with workflow/branch/status filters and matches plain-text job logs', async () => {
    const api = actionsApi({
      routes: {
        '/repos/acme/one/actions/workflows/release.yml/runs': {
          body: { workflow_runs: [{ id: 1 }] },
        },
      },
    });
    const runs = createRunManager({ rest: api.rest });
    expect(
      (
        await runs.list(repository, {
          workflow: 'release.yml',
          branch: 'main',
          status: 'failure',
        })
      )[0].id
    ).toBe(1);
    expect(api.calls[0].query.get('branch')).toBe('main');
    expect(api.calls[0].query.get('status')).toBe('failure');
    const lines = await runs.logs(
      'https://github.com/acme/one/actions/runs/1',
      { grep: ['unauthorized'] }
    );
    expect(lines[0].text).toContain('unauthorized');
    expect(lines[0].runUrl).toBe(api.run.html_url);
  });
  it('does not report an older failure behind a latest successful default-branch run', async () => {
    const api = actionsApi({
      routes: {
        '/orgs/acme/repos': {
          body: [{ full_name: 'acme/one', default_branch: 'main' }],
        },
      },
    });
    expect(
      await createRunManager({ rest: api.rest }).failures({
        org: 'acme',
        grep: ['unauthorized'],
      })
    ).toEqual([]);
    const query = api.calls.find((call) => call.path.endsWith('/runs')).query;
    expect(query.get('branch')).toBe('main');
    expect(query.has('status')).toBe(false);
  });
});
