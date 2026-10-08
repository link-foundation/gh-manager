import { describe, it, expect } from 'test-anywhere';
import {
  protectionPolicy,
  flagRule,
  rulesetProtects,
  updateRuleset,
} from '../src/protection/policy.js';
import { protectionRuleset, protectionApi } from './fixtures/protection-api.js';
import { runCommand } from './fixtures/cli-runner.js';

describe('protection policies', () => {
  it('always includes both default rules in an opt-in JSON policy', () => {
    const policy = protectionPolicy({
      document: {
        name: 'guard',
        rules: [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'build' }] },
          },
        ],
      },
    });
    expect(policy.rules.map((rule) => rule.type)).toEqual([
      'deletion',
      'non_fast_forward',
      'required_status_checks',
    ]);
    expect(policy.name).toBe('guard');
  });

  it('accepts server defaults alongside requested pull request parameters', () => {
    const wanted = flagRule('pull_request');
    const existing = protectionRuleset({
      rules: [
        ...protectionPolicy().rules,
        {
          type: 'pull_request',
          parameters: {
            ...wanted.parameters,
            allowed_merge_methods: ['merge', 'squash', 'rebase'],
          },
        },
      ],
    });
    expect(rulesetProtects(existing, { rules: [wanted] })).toBe(true);
  });

  it('does not treat disabled, bypassable or partial rulesets as all-branch protection', () => {
    for (const extra of [
      { enforcement: 'evaluate' },
      {
        bypass_actors: [
          { actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
        ],
      },
      {
        conditions: {
          ref_name: { include: ['~ALL'], exclude: ['refs/heads/dev'] },
        },
      },
      { target: 'tag' },
    ]) {
      expect(
        rulesetProtects(protectionRuleset(extra), protectionPolicy())
      ).toBe(false);
    }
  });

  it('recognizes all-repository organization rules that also prevent renames', () => {
    const existing = protectionRuleset({
      conditions: {
        ref_name: { include: ['~ALL'], exclude: [] },
        repository_name: { include: ['~ALL'], exclude: [], protected: true },
      },
    });
    expect(rulesetProtects(existing, protectionPolicy(), true)).toBe(true);
  });

  it('preserves the organization restriction on repository renames during updates', () => {
    const existing = protectionRuleset({
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
        repository_name: { include: ['one'], exclude: [], protected: true },
      },
      rules: [{ type: 'deletion' }],
    });
    const body = updateRuleset(existing, protectionPolicy(), true);
    expect(body.conditions.repository_name.protected).toBe(true);
    expect(body.conditions.repository_name.include).toEqual(['~ALL']);
  });

  it('rejects malformed and narrowing policies', () => {
    for (const document of [
      null,
      [],
      { rules: 'deletion' },
      { rules: [], target: 'tag' },
      { rules: [], enforcement: 'disabled' },
      { rules: [], bypass_actors: [] },
      { rules: [{ type: 'not_a_rule' }] },
      { rules: [{ type: 'required_status_checks' }] },
    ]) {
      let code;
      try {
        protectionPolicy({ document });
      } catch (error) {
        code = error.exitCode;
      }
      expect(code).toBe(2);
    }
  });

  it('reads a parameterized policy through the actual --from command', async () => {
    const api = protectionApi();
    const result = await runCommand(
      [
        'protect',
        'acme/one',
        '--from',
        'examples/protection-policy.json',
        '--name',
        'checks',
      ],
      { github: api }
    );
    expect(result.code).toBe(0);
    const write = api.calls.find((call) => call.method === 'POST');
    expect(write.body.name).toBe('checks');
    expect(write.body.rules[2].parameters.required_status_checks).toEqual([
      { context: 'build' },
    ]);
  });

  it('reports an unreadable policy file as a usage error with no API calls', async () => {
    const api = protectionApi();
    const result = await runCommand(
      ['protect', 'acme/one', '--from', 'no-such-policy.json'],
      { github: api }
    );
    expect(result.code).toBe(2);
    expect(api.calls.length).toBe(0);
  });
});
