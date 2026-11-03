import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'test-anywhere';
import { createRulesetDrift } from '../src/protection/drift.js';
import { runCommand } from './fixtures/cli-runner.js';
import {
  desiredPolicy,
  driftApi,
  HEAD,
  LIVE_RULESET_ID,
  liveCheckRuns,
  liveRuleset,
  liveWorkflows,
  REPO,
} from './fixtures/drift-api.js';

const repo = { owner: 'acme', name: 'links-notation' };
const drift = (api) =>
  createRulesetDrift({ rest: api.rest, verificationTimeout: 0 });
const yes = { confirm: async () => true };
const caught = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
};
const checksOf = (ruleset) =>
  ruleset.rules
    .find((rule) => rule.type === 'required_status_checks')
    .parameters.required_status_checks.map((check) => check.context);
const policyWith = (contexts, extra = {}) => {
  const policy = desiredPolicy();
  const rule = policy.rules.find(
    (item) => item.type === 'required_status_checks'
  );
  rule.parameters.required_status_checks = contexts.map((context) => ({
    context,
    integration_id: 15368,
  }));
  return { ...policy, ...extra };
};
const withoutJob = (job) => {
  const files = liveWorkflows();
  const ci = files['.github/workflows/ci.yml'];
  const start = ci.indexOf(`  ${job}:\n`);
  const end = ci.indexOf('\n\n', start);
  files['.github/workflows/ci.yml'] =
    ci.slice(0, start) + (end === -1 ? '' : ci.slice(end + 2));
  return files;
};
const setting = (plan, name) =>
  plan.findings.filter((item) => item.setting === name);

describe('required-check drift on the live links-notation shape', () => {
  it('reports exactly Cpp, Swift and Kotlin missing without writing', async () => {
    const api = driftApi();
    const plan = await drift(api).plan(repo, desiredPolicy());
    expect(plan.branch).toBe('main');
    expect(plan.headSha).toBe(HEAD);
    expect(plan.checks.missing).toEqual(['Cpp', 'Swift', 'Kotlin']);
    expect(
      setting(plan, 'required-status-check').map((item) => item.context)
    ).toEqual(['Cpp', 'Swift', 'Kotlin']);
    expect(plan.findings.length).toBe(3);
    expect(plan.findings.every((item) => item.fixable)).toBe(true);
    expect(plan.findings[0].evidence[0].file).toBe('.github/workflows/ci.yml');
    expect(plan.action).toBe('update');
    expect(plan.ruleset.id).toBe(LIVE_RULESET_ID);
    expect(api.writes()).toEqual([]);
  });

  it('repairs ruleset 24860631 in place keeping main-only scope and every protection', async () => {
    const api = driftApi();
    const manager = drift(api);
    const plan = await manager.plan(repo, desiredPolicy());
    const result = await manager.apply(plan, desiredPolicy(), yes);
    expect(result.changed).toBe(true);
    expect(api.writes().length).toBe(1);
    const [write] = api.writes();
    expect(write.method).toBe('PUT');
    expect(write.path).toBe(`/repos/${REPO}/rulesets/${LIVE_RULESET_ID}`);
    const live = liveRuleset();
    expect(write.body.conditions).toEqual(live.conditions);
    expect(write.body.bypass_actors).toEqual([]);
    expect(write.body.enforcement).toBe('active');
    expect(write.body.rules.slice(0, 3)).toEqual(live.rules.slice(0, 3));
    const checks = write.body.rules[3].parameters;
    expect(checks.strict_required_status_checks_policy).toBe(true);
    expect(checks.do_not_enforce_on_create).toBe(false);
    expect(
      checks.required_status_checks.every(
        (check) => check.integration_id === 15368
      )
    ).toBe(true);
    expect(checksOf(write.body)).toEqual([
      'JavaScript',
      'Rust',
      'Python',
      'Java',
      'Go',
      'CSharp',
      'PHP',
      'Cpp',
      'Swift',
      'Kotlin',
    ]);
    expect(result.readBack.effectiveChecks.length).toBe(10);
    expect(result.findings.every((item) => item.resolved)).toBe(true);
    expect(api.calls.some((call) => call.path.includes('/actions/'))).toBe(
      false
    );
  });

  it('is a no-op when applied again', async () => {
    const api = driftApi();
    const manager = drift(api);
    await manager.apply(
      await manager.plan(repo, desiredPolicy()),
      desiredPolicy(),
      yes
    );
    const again = await manager.plan(repo, desiredPolicy());
    expect(again.action).toBe('no change');
    expect(again.compliant).toBe(true);
    let asked = false;
    const result = await manager.apply(again, desiredPolicy(), {
      confirm: async () => (asked = true),
    });
    expect(result.changed).toBe(false);
    expect(asked).toBe(false);
    expect(api.writes().length).toBe(1);
  });

  it('never creates a duplicate ruleset when no ruleset matches the policy name', async () => {
    const api = driftApi();
    const plan = await drift(api).plan(
      repo,
      policyWith(['JavaScript', 'Cpp'], { name: 'Different name' })
    );
    expect(plan.action).toBe('update');
    expect(plan.ruleset.id).toBe(LIVE_RULESET_ID);
  });

  it('creates a ruleset only when none covers the branch', async () => {
    const api = driftApi({ rulesets: [] });
    const manager = drift(api);
    const plan = await manager.plan(repo, desiredPolicy());
    expect(plan.action).toBe('create');
    await manager.apply(plan, desiredPolicy(), yes);
    const [write] = api.writes();
    expect(write.method).toBe('POST');
    expect(write.body.conditions.ref_name.include).toEqual(['refs/heads/main']);
    expect(write.body.bypass_actors).toEqual([]);
    expect(checksOf(write.body).length).toBe(10);
  });
});

describe('required-check drift safety', () => {
  it('keeps a narrower ruleset scope and stronger settings', async () => {
    const live = liveRuleset();
    live.rules[2].parameters.required_approving_review_count = 2;
    live.rules[2].parameters.require_code_owner_review = true;
    live.bypass_actors = [
      { actor_id: 5, actor_type: 'Team', bypass_mode: 'pull_request' },
    ];
    const api = driftApi({ rulesets: [live] });
    const policy = desiredPolicy();
    policy.conditions.ref_name.include = ['~ALL'];
    const manager = drift(api);
    const plan = await manager.plan(repo, policy);
    expect(setting(plan, 'ruleset-scope').length).toBe(1);
    expect(setting(plan, 'ruleset-bypass-actors').length).toBe(1);
    await manager.apply(plan, policy, yes);
    const [write] = api.writes();
    expect(write.body.conditions.ref_name.include).toEqual(['refs/heads/main']);
    expect(write.body.bypass_actors.length).toBe(1);
    expect(write.body.rules[2].parameters.required_approving_review_count).toBe(
      2
    );
    expect(write.body.rules[2].parameters.require_code_owner_review).toBe(true);
  });

  it('activates an inactive ruleset and adds no second one', async () => {
    const api = driftApi({
      rulesets: [liveRuleset({ enforcement: 'evaluate' })],
    });
    const plan = await drift(api).plan(repo, desiredPolicy());
    expect(setting(plan, 'ruleset-enforcement')[0].fixable).toBe(true);
    expect(plan.checks.missing.length).toBe(10);
    expect(plan.after.enforcement).toBe('active');
    expect(plan.ruleset.id).toBe(LIVE_RULESET_ID);
  });

  it('restores strict same-commit validation when it was weakened', async () => {
    const live = liveRuleset();
    live.rules[3].parameters.strict_required_status_checks_policy = false;
    const api = driftApi({ rulesets: [live] });
    const plan = await drift(api).plan(repo, desiredPolicy());
    expect(setting(plan, 'ruleset-rule')[0].rule).toBe(
      'required_status_checks'
    );
    expect(
      plan.after.rules[3].parameters.strict_required_status_checks_policy
    ).toBe(true);
  });

  it('asks for --ruleset when several rulesets could be the target', async () => {
    const other = liveRuleset({ id: 5, name: 'Another main ruleset' });
    const first = liveRuleset({ enforcement: 'evaluate' });
    const api = driftApi({ rulesets: [first, other] });
    const policy = policyWith(['Cpp'], { name: 'Unmatched' });
    other.enforcement = 'evaluate';
    const plan = await drift(api).plan(repo, policy);
    expect(plan.action).toBe('blocked');
    expect(setting(plan, 'ruleset-target')[0].reason).toContain('--ruleset');
    const pinned = await drift(api).plan(repo, policy, { rulesetId: 5 });
    expect(pinned.ruleset.id).toBe(5);
  });

  it('rejects policies that add bypass actors', async () => {
    const api = driftApi();
    const error = await caught(
      drift(api).plan(repo, {
        ...desiredPolicy(),
        bypass_actors: [{ actor_id: 1, actor_type: 'Team' }],
      })
    );
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('never adds bypass actors');
  });
});

describe('required-check drift sources', () => {
  it('honors inherited organization rules and never edits them', async () => {
    const org = {
      id: 77,
      name: 'org baseline',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Organization',
      source: 'acme',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      bypass_actors: [],
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [
              { context: 'Cpp', integration_id: 15368 },
              { context: 'Swift', integration_id: 999 },
            ],
          },
        },
      ],
    };
    const api = driftApi({ orgRulesets: [org] });
    const manager = drift(api);
    const plan = await manager.plan(repo, desiredPolicy());
    expect(plan.checks.missing).toEqual(['Kotlin']);
    const swift = setting(plan, 'required-status-check').find(
      (item) => item.context === 'Swift'
    );
    expect(swift.fixable).toBe(false);
    expect(swift.reason).toContain('organization ruleset 77');
    await manager.apply(plan, desiredPolicy(), yes);
    expect(api.writes().length).toBe(1);
    expect(api.writes()[0].path).toBe(
      `/repos/${REPO}/rulesets/${LIVE_RULESET_ID}`
    );
    expect(checksOf(api.writes()[0].body).slice(7)).toEqual(['Kotlin']);
  });

  it('counts classic protection and never edits it', async () => {
    const api = driftApi({
      classic: {
        required_status_checks: {
          strict: true,
          contexts: ['Swift', 'Kotlin'],
          checks: [
            { context: 'Swift', app_id: 15368 },
            { context: 'Kotlin', app_id: 999 },
          ],
        },
      },
    });
    const manager = drift(api);
    const plan = await manager.plan(repo, desiredPolicy());
    expect(plan.checks.missing).toEqual(['Cpp']);
    expect(plan.checks.wrongIntegration).toEqual(['Kotlin']);
    const kotlin = setting(plan, 'required-status-check').find(
      (item) => item.context === 'Kotlin'
    );
    expect(kotlin.reason).toContain('classic branch protection');
    await manager.apply(plan, desiredPolicy(), yes);
    expect(api.writes().map((call) => call.path)).toEqual([
      `/repos/${REPO}/rulesets/${LIVE_RULESET_ID}`,
    ]);
    expect(checksOf(api.writes()[0].body).slice(7)).toEqual(['Cpp']);
  });

  it('refuses a check whose runs come from another app', async () => {
    const runs = liveCheckRuns().map((run) =>
      run.name === 'Cpp' ? { ...run, app: { id: 999 } } : run
    );
    const api = driftApi({ checkRuns: runs });
    const plan = await drift(api).plan(repo, desiredPolicy());
    const identity = setting(plan, 'required-check-app')[0];
    expect(identity.context).toBe('Cpp');
    expect(plan.checks.blocked).toEqual(['Cpp']);
    expect(checksOf(plan.after).slice(7)).toEqual(['Swift', 'Kotlin']);
  });

  it('keeps an existing different app binding and reports the conflict', async () => {
    const live = liveRuleset();
    live.rules[3].parameters.required_status_checks[1].integration_id = 999;
    const api = driftApi({ rulesets: [live] });
    const plan = await drift(api).plan(repo, desiredPolicy());
    expect(plan.checks.wrongIntegration).toEqual(['Rust']);
    expect(plan.conflicts[0]).toContain('Rust');
    expect(
      plan.after.rules[3].parameters.required_status_checks[1].integration_id
    ).toBe(999);
  });
});

describe('required-check drift against workflow revisions', () => {
  it('refuses a check an older workflow revision does not report', async () => {
    const api = driftApi({
      workflows: withoutJob('kotlin_check'),
      checkRuns: liveCheckRuns().filter((run) => run.name !== 'Kotlin'),
    });
    const plan = await drift(api).plan(repo, desiredPolicy());
    const missing = setting(plan, 'required-check-workflow')[0];
    expect(missing.context).toBe('Kotlin');
    expect(missing.current).toBe('missing');
    expect(checksOf(plan.after).slice(7)).toEqual(['Cpp', 'Swift']);
  });

  it('accepts a gate a newer workflow revision adds before it has run', async () => {
    const api = driftApi({
      checkRuns: liveCheckRuns().filter((run) => run.name !== 'Swift'),
    });
    const plan = await drift(api).plan(repo, desiredPolicy());
    expect(plan.warnings.some((text) => text.includes('Swift'))).toBe(true);
    expect(checksOf(plan.after).slice(7)).toEqual(['Cpp', 'Swift', 'Kotlin']);
  });

  it('refuses production-only publishers and warns about matrix jobs', async () => {
    const files = liveWorkflows();
    files['.github/workflows/matrix.yml'] = [
      'on: [pull_request]',
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        os: [gcc, clang]',
      '    runs-on: ubuntu-latest',
      '    steps: [{ run: "true" }]',
    ].join('\n');
    const api = driftApi({ workflows: files });
    const plan = await drift(api).plan(
      repo,
      policyWith(['JavaScript', 'release / js', 'test (gcc)'])
    );
    const pushOnly = setting(plan, 'required-check-workflow')[0];
    expect(pushOnly.context).toBe('release / js');
    expect(pushOnly.current).toBe('push-only');
    expect(plan.warnings.some((text) => text.includes('test (gcc)'))).toBe(
      true
    );
    expect(checksOf(plan.after)).toContain('test (gcc)');
    expect(checksOf(plan.after)).not.toContain('release / js');
  });
});

describe('required-check drift repairs', () => {
  it('refuses a stale saved plan', async () => {
    const api = driftApi();
    const manager = drift(api);
    const saved = JSON.parse(
      JSON.stringify(await manager.plan(repo, desiredPolicy()))
    );
    api.state.rulesets[0].updated_at = '2026-11-02T00:00:00.000Z';
    api.state.rulesets[0].rules.splice(2, 1);
    const fresh = await manager.plan(repo, desiredPolicy());
    const error = await caught(
      manager.apply(fresh, desiredPolicy(), { ...yes, savedPlan: saved })
    );
    expect(error.message).toContain('stale');
    expect(api.writes()).toEqual([]);
  });

  it('refuses to write over a concurrent change', async () => {
    let planned = false;
    const api = driftApi({
      onRead: ({ path, state }) => {
        if (planned && path.endsWith(`/rulesets/${LIVE_RULESET_ID}`)) {
          state.rulesets[0].updated_at = '2026-11-02T00:00:00.000Z';
        }
      },
    });
    const manager = drift(api);
    const plan = await manager.plan(repo, desiredPolicy());
    planned = true;
    const error = await caught(manager.apply(plan, desiredPolicy(), yes));
    expect(error.message).toContain('changed after the plan was reviewed');
    expect(api.writes()).toEqual([]);
  });

  it('reports missing Administration permission with browser and API fallbacks', async () => {
    const api = driftApi({
      reject: ({ method }) =>
        method === 'PUT'
          ? { status: 403, message: 'Resource not accessible by integration' }
          : null,
    });
    const manager = drift(api);
    const result = await manager.apply(
      await manager.plan(repo, desiredPolicy()),
      desiredPolicy(),
      yes
    );
    expect(result.action).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.reason).toContain('Administration');
    expect(result.reason).toContain(
      `https://github.com/${REPO}/settings/rules/${LIVE_RULESET_ID}`
    );
    expect(result.reason).toContain('gh api --method PUT');
  });

  it('does not write without admin permission', async () => {
    const api = driftApi({
      repository: { permissions: { admin: false, push: true } },
    });
    const manager = drift(api);
    const plan = await manager.plan(repo, desiredPolicy());
    expect(setting(plan, 'administration-permission').length).toBe(1);
    const result = await manager.apply(plan, desiredPolicy(), yes);
    expect(result.exitCode).toBe(3);
    expect(api.writes()).toEqual([]);
  });

  it('blocks repairs when bypass actors are unreadable', async () => {
    const api = driftApi({ hideBypass: true });
    const plan = await drift(api).plan(repo, desiredPolicy());
    expect(plan.action).toBe('blocked');
    expect(setting(plan, 'protection-evidence')[0].evidenceSource).toContain(
      'bypass actors'
    );
  });

  it('reports unreadable effective rules as a finding', async () => {
    const api = driftApi({
      reject: ({ path }) =>
        path.includes('/rules/branches/')
          ? { status: 403, message: 'Forbidden' }
          : null,
    });
    const plan = await drift(api).plan(repo, desiredPolicy());
    expect(plan.action).toBe('blocked');
    expect(setting(plan, 'protection-evidence')[0].evidenceSource).toBe(
      'effective branch rules'
    );
  });
});

describe('protect --from <scoped ruleset>', () => {
  const withPolicy = async (run) => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-manager-drift-'));
    try {
      const policy = join(dir, 'main-ruleset.json');
      writeFileSync(policy, JSON.stringify(desiredPolicy()));
      return await run(policy, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('diagnoses the issue command read-only with exit 0', async () =>
    withPolicy(async (policy) => {
      const api = driftApi();
      const result = await runCommand(
        ['protect', REPO, '--from', policy, '--dry-run', '--json'],
        { github: api }
      );
      expect(result.code).toBe(0);
      const output = JSON.parse(result.output);
      expect(output.dryRun).toBe(true);
      expect(output.checks.missing).toEqual(['Cpp', 'Swift', 'Kotlin']);
      expect(api.writes()).toEqual([]);
      expect(result.asked).toEqual([]);
    }));

  it('applies a reviewed plan file and refuses it once stale', async () =>
    withPolicy(async (policy, dir) => {
      const api = driftApi();
      const dry = await runCommand(
        ['protect', REPO, '--from', policy, '--dry-run', '--json'],
        { github: api }
      );
      const planFile = join(dir, 'plan.json');
      writeFileSync(planFile, dry.output);
      const applied = await runCommand(
        ['protect', REPO, '--from', policy, '--plan', planFile, '--yes'],
        { github: api }
      );
      expect(applied.code).toBe(0);
      expect(applied.output).toContain('10 required checks effective');
      expect(api.writes().length).toBe(1);
      const stale = await runCommand(
        ['protect', REPO, '--from', policy, '--plan', planFile, '--yes'],
        { github: api }
      );
      expect(stale.code).toBe(1);
      expect(stale.errors).toContain('stale');
      expect(api.writes().length).toBe(1);
      expect(readFileSync(planFile, 'utf8')).toBe(dry.output);
    }));

  it('aborts without confirmation', async () =>
    withPolicy(async (policy) => {
      const api = driftApi();
      const result = await runCommand(['protect', REPO, '--from', policy], {
        github: api,
        confirm: () => false,
      });
      expect(result.code).toBe(5);
      expect(api.writes()).toEqual([]);
    }));

  it('rejects organization targets for scoped policies', async () =>
    withPolicy(async (policy) => {
      const result = await runCommand(
        ['protect', '--org', 'acme', '--from', policy, '--dry-run'],
        { github: driftApi() }
      );
      expect(result.code).toBe(2);
    }));
});
