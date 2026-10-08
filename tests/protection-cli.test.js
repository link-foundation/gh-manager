import { describe, it, expect } from 'test-anywhere';
import { runCommand } from './fixtures/cli-runner.js';
import {
  protectionApi,
  protectionRuleset,
  repository,
} from './fixtures/protection-api.js';

const writes = (api) => api.calls.filter((call) => call.method !== 'GET');
const command = (args, api, options = {}) =>
  runCommand(['protect', ...args], { github: api, ...options });

describe('protect command', () => {
  it('creates the default all-branch repository ruleset and verifies it', async () => {
    const api = protectionApi();
    const result = await command(['acme/one'], api);
    expect(result.code).toBe(0);
    expect(writes(api)[0].body).toEqual({
      name: 'protection',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
      bypass_actors: [],
    });
    expect(
      api.calls.some(
        (call) => call.path === '/repos/acme/one/rules/branches/main'
      )
    ).toBe(true);
    expect(result.output).toContain('create');
  });

  it('uses one organization ruleset covering current and future repositories', async () => {
    const api = protectionApi({
      repositories: [
        repository('one'),
        repository('two'),
        repository('old', { archived: true }),
        repository('fork', { fork: true }),
      ],
    });
    const result = await command(['--org', 'acme'], api);
    expect(result.code).toBe(0);
    expect(writes(api).length).toBe(1);
    expect(writes(api)[0].path).toBe('/orgs/acme/rulesets');
    expect(writes(api)[0].body.conditions.repository_name).toEqual({
      include: ['~ALL'],
      exclude: [],
      protected: false,
    });
    expect(result.output).toContain('acme/two');
    expect(result.output).toContain('archived');
    expect(result.output).toContain('fork');
    expect(result.asked.length).toBe(1);
  });

  it('falls back on org API denial and explains scope recovery', async () => {
    const api = protectionApi({
      reject: ({ path }) =>
        path.startsWith('/orgs/acme/rulesets')
          ? { status: 404, message: 'Not Found' }
          : null,
    });
    const result = await command(['--org', 'acme', '--yes'], api, {
      realPrompt: true,
    });
    expect(result.code).toBe(0);
    expect(writes(api)[0].path).toBe('/repos/acme/one/rulesets');
    expect(result.output + result.errors).toContain(
      'gh auth refresh -s admin:org'
    );
  });

  it('falls back after GitHub rejects org creation for the plan', async () => {
    const api = protectionApi({
      reject: ({ path, method }) =>
        path === '/orgs/acme/rulesets' && method === 'POST'
          ? { status: 422, message: 'Upgrade to use organization rulesets' }
          : null,
    });
    const result = await command(['--org', 'acme'], api);
    expect(result.code).toBe(0);
    expect(writes(api).map((call) => call.path)).toEqual([
      '/orgs/acme/rulesets',
      '/repos/acme/one/rulesets',
    ]);
    expect(result.output + result.errors).toContain('Upgrade');
  });

  it('enumerates user-owned repositories without trying account rulesets', async () => {
    const api = protectionApi();
    const result = await command(['--user', 'acme'], api);
    expect(result.code).toBe(0);
    expect(
      api.calls.some((call) =>
        call.path.startsWith('/users/acme/repos?type=owner')
      )
    ).toBe(true);
    expect(
      api.calls.some((call) => call.path.startsWith('/users/acme/rulesets'))
    ).toBe(false);
  });

  it('reads details before deciding that an inherited ruleset already protects branches', async () => {
    const api = protectionApi({
      rulesets: {
        '/repos/acme/one/rulesets': [
          protectionRuleset({
            name: 'org guard',
            source_type: 'Organization',
            source: 'acme',
          }),
        ],
      },
    });
    const result = await command(['acme/one'], api);
    expect(result.code).toBe(0);
    expect(result.output).toContain('already protected');
    expect(writes(api).length).toBe(0);
  });
});

describe('protect plans, confirmation and custom policies', () => {
  it('shows the update diff, preserves stricter rules and asks before updating', async () => {
    const existing = protectionRuleset({
      enforcement: 'disabled',
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/dev'] },
      },
      rules: [{ type: 'deletion' }, { type: 'required_signatures' }],
    });
    const api = protectionApi({
      rulesets: { '/repos/acme/one/rulesets': [existing] },
    });
    const result = await command(['acme/one'], api);
    expect(result.code).toBe(0);
    expect(result.asked.length).toBe(1);
    expect(result.output).toContain('before');
    expect(result.output).toContain('after');
    expect(writes(api)[0].method).toBe('PUT');
    expect(
      writes(api)[0].body.rules.some(
        (rule) => rule.type === 'required_signatures'
      )
    ).toBe(true);
  });

  it('changes nothing when an update is declined', async () => {
    const api = protectionApi({
      rulesets: {
        '/repos/acme/one/rulesets': [
          protectionRuleset({ rules: [{ type: 'deletion' }] }),
        ],
      },
    });
    const result = await command(['acme/one'], api, { confirm: () => false });
    expect(result.code).toBe(5);
    expect(writes(api).length).toBe(0);
  });

  it('includes the repository list and update diff in JSON-mode confirmation', async () => {
    const api = protectionApi({
      rulesets: {
        '/repos/acme/one/rulesets': [
          protectionRuleset({ rules: [{ type: 'deletion' }] }),
        ],
      },
    });
    const result = await command(['--user', 'acme', '--json'], api);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).repositories[0].verified).toBe(true);
    expect(result.asked[0]).toContain('acme/one');
    expect(result.asked[0]).toContain('before');
    expect(result.asked[0]).toContain('after');
  });

  it('reports each repository in dry run with no writes or confirmation', async () => {
    const api = protectionApi({
      repositories: [repository('one'), repository('old', { archived: true })],
      rulesets: { '/repos/acme/one/rulesets': [protectionRuleset()] },
    });
    const result = await command(
      ['--user', 'acme', '--dry-run', '--json'],
      api
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.output);
    expect(report.repositories[0].action).toBe('already protected');
    expect(report.repositories[1].reason).toContain('archived');
    expect(result.asked.length).toBe(0);
    expect(writes(api).length).toBe(0);
  });

  it('requires consent for noninteractive bulk runs and --yes supplies it', async () => {
    const api = protectionApi();
    const result = await command(['--org', 'acme'], api, { realPrompt: true });
    expect(result.code).toBe(5);
    expect(writes(api).length).toBe(0);
  });

  it('supports a custom name and additive stricter rules', async () => {
    const api = protectionApi();
    const result = await command(
      [
        'acme/one',
        '--name',
        'guard',
        '--rule',
        'required_signatures',
        '--rule',
        'required_linear_history',
      ],
      api
    );
    expect(result.code).toBe(0);
    expect(writes(api)[0].body.name).toBe('guard');
    expect(writes(api)[0].body.rules.map((rule) => rule.type)).toEqual([
      'deletion',
      'non_fast_forward',
      'required_signatures',
      'required_linear_history',
    ]);
  });

  it('rejects ambiguous target selections before API access', async () => {
    for (const args of [
      [],
      ['--org', 'acme', '--user', 'acme'],
      ['--user', 'acme', '--user', 'other'],
      ['acme/one', '--user', 'acme'],
    ]) {
      const api = protectionApi();
      const result = await command(args, api);
      expect(result.code).toBe(2);
      expect(api.calls.length).toBe(0);
    }
  });
});
