import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRepoManager } from '../src/index.js';
import { actionsApi } from './fixtures/actions-api.js';
import { apiCommand } from './fixtures/cli.js';

function fixture() {
  return actionsApi({
    routes: {
      '/users/A-ST-RA/repos': ({ query }) => ({
        body:
          query.get('page') === '1'
            ? Array.from({ length: 100 }, (_, id) => ({
                full_name: `A-ST-RA/r${id}`,
                fork: id === 0,
                archived: id === 1,
              }))
            : [{ full_name: 'A-ST-RA/last' }],
      }),
      '/user/repos': {
        body: [
          { full_name: 'a-st-ra/r0', fork: true },
          { full_name: 'A-ST-RA/private', private: true },
          { full_name: 'other/collaborator' },
        ],
      },
      '/repos/a-st-ra/r0/issues': ({ query }) => ({
        body:
          query.get('page') === '1'
            ? Array.from({ length: 100 }, (_, number) => ({
                number,
                title: `issue ${number}`,
                ...(number === 0 ? { pull_request: {} } : {}),
              }))
            : [{ number: 101 }],
      }),
      ...Object.fromEntries(
        [
          ...Array.from({ length: 99 }, (_, i) => `r${i + 1}`),
          'last',
          'private',
        ].map((name) => [
          `/repos/A-ST-RA/${name}/issues`,
          { body: name === 'r2' ? [] : [{ number: 1 }] },
        ])
      ),
    },
  });
}

describe('open issues across owned repositories', () => {
  it('paginates repos and issues, includes archives/forks/private repos, excludes PRs and other owners', async () => {
    const api = fixture();
    const result = await apiCommand(
      ['repo', 'issues', '--user', 'A-ST-RA', '--json'],
      api
    );
    assert.equal(result.code, 0, result.errors);
    const issues = JSON.parse(result.output);
    assert.equal(issues.length, 200);
    assert.equal(issues[0].title, 'issue 1');
    assert.equal(issues[99].number, 101);
    assert(issues.some((issue) => issue.repository === 'A-ST-RA/r1'));
    assert(issues.some((issue) => issue.repository === 'A-ST-RA/last'));
    assert(issues.some((issue) => issue.repository === 'A-ST-RA/private'));
    const calls = api.calls.filter((call) => call.path.endsWith('/issues'));
    assert.equal(calls.length, 103);
    assert(calls.every((call) => call.query.get('state') === 'open'));
    assert(calls.every((call) => call.query.get('per_page') === '100'));
    assert(api.calls.every((call) => call.method === 'GET'));
  });

  it('can exclude forks and archives explicitly', async () => {
    const api = fixture();
    const result = await apiCommand(
      [
        'repo',
        'issues',
        '--user',
        'A-ST-RA',
        '--no-include-forks',
        '--no-include-archived',
      ],
      api
    );
    assert.equal(result.code, 0, result.errors);
    assert(!api.calls.some((call) => /\/r[01]\/issues$/.test(call.path)));
  });

  it('supports anonymous organization discovery and empty issue lists', async () => {
    const api = actionsApi({
      routes: {
        '/orgs/acme/repos': { body: [{ full_name: 'acme/one' }] },
        '/repos/acme/one/issues': { body: [] },
      },
    });
    api.rest.hasToken = false;
    assert.deepEqual(
      await createRepoManager({ rest: api.rest }).issues({ org: 'acme' }),
      []
    );
    assert.equal(api.calls.length, 2);
  });

  it('rejects missing, ambiguous and invalid owners before API requests', async () => {
    const api = actionsApi();
    for (const args of [
      [],
      ['--user', 'a', '--org', 'b'],
      ['--user', 'a', '--user', 'b'],
      ['--user', '../a'],
      ['unexpected', '--user', 'a'],
    ]) {
      const result = await apiCommand(['repo', 'issues', ...args], api);
      assert.equal(result.code, 2, result.errors);
    }
    assert.equal(api.calls.length, 0);
  });

  it('rejects denied and malformed inventories', async () => {
    for (const response of [
      { status: 403, body: {} },
      { status: 500, body: {} },
      { body: {} },
    ]) {
      const api = actionsApi({
        routes: {
          '/orgs/acme/repos': {
            body: [{ full_name: 'acme/one' }, { full_name: 'acme/two' }],
          },
          '/repos/acme/one/issues': { body: [{ number: 1 }] },
          '/repos/acme/two/issues': response,
        },
      });
      const result = await apiCommand(
        ['repo', 'issues', '--org', 'acme', '--json'],
        api
      );
      assert.notEqual(result.code, 0);
      assert.equal(result.output, '');
    }
  });
});
