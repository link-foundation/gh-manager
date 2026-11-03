import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'test-anywhere';
import { createDoctor } from '../src/doctor/manager.js';
import { createRulesetDrift } from '../src/protection/drift.js';
import { createLogger } from '../src/logging.js';
import { runCommand } from './fixtures/cli-runner.js';
import {
  desiredPolicy,
  driftApi,
  LIVE_RULESET_ID,
  REPO,
} from './fixtures/drift-api.js';

const log = createLogger({ stdout: () => {}, stderr: () => {} });
const AUTH_FAILURE = 'npm error code E401\nnpm error 401 Unauthorized';

const doctor = (api) =>
  createDoctor({
    rest: api.rest,
    log,
    drift: createRulesetDrift({ rest: api.rest, log, verificationTimeout: 0 }),
    getSession: async () => {
      throw new Error('no browser session in these tests');
    },
  });

const branchFindings = (report) =>
  report.repositories[0].findings.filter((f) => f.source === 'branch-rules');

describe('doctor --from <reviewed ruleset>', () => {
  it('reports exactly Cpp, Swift and Kotlin without mutations', async () => {
    const api = driftApi({ failedLog: AUTH_FAILURE });
    const report = await doctor(api).scan(
      { repo: REPO },
      { policy: desiredPolicy() }
    );
    expect(branchFindings(report).map((f) => f.context)).toEqual([
      'Cpp',
      'Swift',
      'Kotlin',
    ]);
    expect(report.repositories[0].branchRules.ruleset.id).toBe(LIVE_RULESET_ID);
    expect(report.exitCode).toBe(1);
    expect(api.writes()).toEqual([]);
  });

  it('repairs the ruleset and never reruns a deterministic auth failure', async () => {
    const api = driftApi({ failedLog: AUTH_FAILURE });
    const report = await doctor(api).scan(
      { repo: REPO },
      { policy: desiredPolicy(), fix: true, confirm: () => true }
    );
    expect(report.remaining).toBe(0);
    expect(api.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT /repos/${REPO}/rulesets/${LIVE_RULESET_ID}`,
    ]);
    expect(report.repositories[0].reruns).toEqual([]);
    expect(
      report.repositories[0].branchRules.readBack.effectiveChecks.length
    ).toBe(10);
    const again = await doctor(api).scan(
      { repo: REPO },
      { policy: desiredPolicy(), fix: true, confirm: () => true }
    );
    expect(branchFindings(again)).toEqual([]);
    expect(api.writes().length).toBe(1);
  });

  it('keeps findings and reports the fallback without Administration permission', async () => {
    const api = driftApi({ repository: { permissions: { admin: false } } });
    const report = await doctor(api).scan(
      { repo: REPO },
      { policy: desiredPolicy(), fix: true, confirm: () => true }
    );
    expect(api.writes()).toEqual([]);
    expect(report.exitCode).toBe(1);
    const settings = branchFindings(report).map((f) => f.setting);
    expect(settings).toContain('administration-permission');
    expect(report.repositories[0].errors[0].error).toContain(
      `/rulesets/${LIVE_RULESET_ID}`
    );
  });
});

describe('doctor --from on the command line', () => {
  const withPolicy = async (document, run) => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-manager-doctor-'));
    try {
      const policy = join(dir, 'main-ruleset.json');
      writeFileSync(policy, JSON.stringify(document));
      return await run(policy);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('diagnoses read-only and repairs with --fix --yes', async () =>
    withPolicy(desiredPolicy(), async (policy) => {
      const api = driftApi({ failedLog: AUTH_FAILURE });
      const dry = await runCommand(['doctor', REPO, '--from', policy], {
        github: api,
      });
      expect(dry.code).toBe(1);
      expect(dry.output).toContain('required-status-check Kotlin');
      expect(api.writes()).toEqual([]);
      const fixed = await runCommand(
        ['doctor', REPO, '--from', policy, '--fix', '--yes', '--json'],
        { github: api, realPrompt: true }
      );
      expect(fixed.code).toBe(0);
      expect(JSON.parse(fixed.output).remaining).toBe(0);
      expect(api.writes().map((c) => c.method)).toEqual(['PUT']);
    }));

  it('rejects an unscoped document and --branch without --from', async () => {
    await withPolicy({ name: 'protection', rules: [] }, async (policy) => {
      const result = await runCommand(['doctor', REPO, '--from', policy], {
        github: driftApi(),
      });
      expect(result.code).toBe(2);
    });
    const result = await runCommand(['doctor', REPO, '--branch', 'main'], {
      github: driftApi(),
    });
    expect(result.code).toBe(2);
  });
});

describe('doctor --from error isolation', () => {
  it('records a branch the policy does not cover as a repository error', async () => {
    const api = driftApi();
    const report = await doctor(api).scan(
      { repo: REPO },
      { policy: desiredPolicy(), branch: 'release' }
    );
    expect(report.exitCode).toBe(1);
    expect(report.repositories[0].repository).toBe(REPO);
    expect(report.repositories[0].errors[0].source).toBe('branch-rules');
    expect(api.writes()).toEqual([]);
  });
});
