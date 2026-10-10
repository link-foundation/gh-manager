import { describe, it, expect } from 'test-anywhere';
import { apiCommand } from './fixtures/cli.js';
import { actionsApi, dispatchedApi } from './fixtures/actions-api.js';
import { secretsApi } from './fixtures/secrets-api.js';

const command = (args, api) => apiCommand([...args, '--json'], api);

describe('discovery and health CLI', () => {
  it('executes secret test dispatch and reports fresh evidence through the CLI', async () => {
    const api = dispatchedApi();
    const result = await command(
      [
        'secret',
        'test',
        'CUSTOM_TOKEN',
        '--repo',
        'acme/one',
        '--timeout',
        '0',
      ],
      api
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).status).toBe('ok');
    expect(
      api.calls
        .filter((call) => call.query.get('event') === 'workflow_dispatch')
        .every((call) => call.query.get('branch') === 'main')
    ).toBe(true);
  });
  it('lists organization/user repositories and matching file contents', async () => {
    const api = actionsApi({
      routes: {
        '/orgs/acme/repos': { body: [{ name: 'one' }] },
        '/users/alice/repos': { body: [{ name: 'personal' }] },
        '/repos/acme/one/git/trees/main': {
          body: { tree: [{ path: 'manifest.json', type: 'blob', sha: 'a' }] },
        },
        '/repos/acme/one/git/blobs/a': {
          body: { encoding: 'base64', content: 'e30=' },
        },
      },
    });
    expect(
      JSON.parse(
        (await command(['repo', 'list', '--org', 'acme'], api)).output
      )[0].name
    ).toBe('one');
    expect(
      JSON.parse(
        (await command(['repo', 'list', '--user', 'alice'], api)).output
      )[0].name
    ).toBe('personal');
    const files = await command(
      [
        'repo',
        'files',
        'acme/one',
        '--match',
        '*.json',
        '--match',
        '**/*.yml',
        '--content',
      ],
      api
    );
    expect(files.code).toBe(0);
    expect(JSON.parse(files.output)[0].content).toBe('{}');
  });
  it('lists runs, matches logs, and finds failed organization runs', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      routes: {
        '/orgs/acme/repos': {
          body: [{ full_name: 'acme/one', default_branch: 'main' }],
        },
      },
    });
    expect(
      (
        await command(
          [
            'runs',
            'list',
            'acme/one',
            '--branch',
            'main',
            '--status',
            'failure',
          ],
          api
        )
      ).code
    ).toBe(0);
    const logs = await command(
      ['runs', 'logs', '1', '--repo', 'acme/one', '--grep', 'unauthorized'],
      api
    );
    expect(JSON.parse(logs.output)[0].text).toContain('unauthorized');
    const failures = await command(
      ['runs', 'failures', '--org', 'acme', '--grep', 'unauthorized'],
      api
    );
    expect(JSON.parse(failures.output)[0].repository).toBe('acme/one');
  });
});

describe('Secret health and generic secrets CLI', () => {
  it('reports secret health and supports a test dry run without dispatching', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      log: '2026-01-01T00:00:02Z CALLER_ERROR',
    });
    const health = await command(
      [
        'secret',
        'health',
        'CUSTOM_TOKEN',
        '--repo',
        'acme/one',
        '--failure-pattern',
        'CALLER_ERROR',
      ],
      api
    );
    expect(health.code).toBe(0);
    expect(JSON.parse(health.output).status).toBe('auth-failing');
    expect(
      (
        await command(
          ['secret', 'test', 'CUSTOM_TOKEN', '--repo', 'acme/one', '--dry-run'],
          api
        )
      ).code
    ).toBe(0);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('ensures a custom repository name and previews caller-named cleanup', async () => {
    const api = await secretsApi({ base: '/repos/acme/one/actions' });
    expect(
      (
        await command(
          ['secret', 'ensure', 'CUSTOM_TOKEN', '--repo', 'acme/one'],
          api
        )
      ).code
    ).toBe(0);
    const cleanup = await command(
      [
        'secret',
        'cleanup',
        'CUSTOM_TOKEN',
        '--repo',
        'acme/one',
        '--reason',
        'Caller migration',
        '--dry-run',
      ],
      api
    );
    expect(cleanup.code).toBe(0);
    expect(JSON.parse(cleanup.output).names).toEqual(['CUSTOM_TOKEN']);
    expect(api.secrets.size).toBe(1);
  });
  it('rejects ambiguous user selection and invalid regex before making requests', async () => {
    const api = actionsApi();
    expect(
      (await command(['repo', 'list', '--user', 'a', '--user', 'b'], api)).code
    ).toBe(2);
    expect(
      (
        await command(
          ['runs', 'logs', '1', '--repo', 'acme/one', '--grep', '['],
          api
        )
      ).code
    ).toBe(2);
    expect(api.calls.length).toBe(0);
  });
});
