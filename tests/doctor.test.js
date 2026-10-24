import { describe, it, expect } from 'test-anywhere';
import { createDoctor } from '../src/doctor/manager.js';
import { createPagesManager } from '../src/pages/manager.js';
import { createSecurityGateway } from '../src/security/gateway.js';
import { createLogger } from '../src/logging.js';
import { createFakeSession } from './fixtures/fake-browser.js';
import { doctorApi } from './fixtures/doctor-api.js';
import { runCommand } from './fixtures/cli-runner.js';

const workflow = (uses) =>
  `on: push\njobs:\n  check:\n    steps:\n      - uses: ${uses}@v4\n`;
const log = createLogger({ stdout: () => {}, stderr: () => {} });
function doctor(api) {
  const session = createFakeSession({ routes: api.routes });
  return createDoctor({
    rest: api.rest,
    log,
    getSession: async () => session,
    pages: createPagesManager({ rest: api.rest, verificationTimeout: 0 }),
    security: (repo) =>
      createSecurityGateway({
        rest: api.rest,
        log,
        repo,
        getSession: async () => session,
        verificationTimeout: 0,
      }),
  });
}

const fix = (api, options = {}) =>
  doctor(api).scan(
    { repo: 'acme/one' },
    { fix: true, confirm: () => true, ...options }
  );

describe('doctor reports and repairs', () => {
  it('reports workflow and failed-log evidence without mutations', async () => {
    const api = doctorApi({
      files: {
        '.github/workflows/site.yaml': workflow('actions/deploy-pages'),
      },
      log: 'line 1\nGet Pages site failed',
    });
    const result = await doctor(api).scan({ repo: 'acme/one' });
    expect(result.exitCode).toBe(1);
    expect(api.writes().length).toBe(0);
    const finding = result.repositories[0].findings[0];
    expect(finding.current).toBe('legacy');
    expect(finding.required).toBe('workflow');
    expect(finding.fixable).toBe(true);
    expect(finding.evidence.map((e) => e.kind)).toEqual(['file', 'log']);
    expect(finding.evidence[1].line).toBe(2);
  });
  it('repairs Pages, verifies the API state and reruns only the causal failed run', async () => {
    const api = doctorApi({
      site: null,
      log: 'Ensure GitHub Pages has been enabled',
    });
    const result = await fix(api);
    expect(result.remaining).toBe(0);
    expect(result.repositories[0].findings[0].result.verifiedBy).toBe('api');
    expect(api.writes().map((c) => c.path)).toEqual([
      '/repos/acme/one/pages',
      '/repos/acme/one/actions/runs/1/rerun-failed-jobs',
    ]);
  });
  it('does not rerun from static evidence alone', async () => {
    const api = doctorApi({
      files: {
        '.github/workflows/site.yml': workflow('actions/configure-pages'),
      },
      log: 'unrelated failure',
    });
    const result = await fix(api);
    expect(result.remaining).toBe(0);
    expect(result.repositories[0].reruns.length).toBe(0);
  });
  it('does not use successful jobs as failure evidence', async () => {
    const api = doctorApi({ log: 'unrelated failure' });
    const result = await doctor(api).scan({ repo: 'acme/one' });
    expect(result.remaining).toBe(0);
    expect(api.calls.some((c) => c.path.endsWith('/jobs/3/logs'))).toBe(false);
  });
  it('ignores a historical scanning failure when default setup is currently enabled', async () => {
    const api = doctorApi({
      log: 'Code scanning is not enabled for this repository',
      defaultSetup: 'configured',
    });
    const report = await fix(api);
    expect(report.remaining).toBe(0);
    expect(api.writes().length).toBe(0);
  });
  it('enables default setup for a scanning failure without an advanced workflow', async () => {
    const api = doctorApi({
      log: 'Code scanning is not enabled for this repository',
    });
    const report = await fix(api);
    expect(report.remaining).toBe(0);
    expect(report.repositories[0].findings[0].result.verifiedBy).toBe('api');
    expect(api.writes()[0].body).toEqual({ state: 'configured' });
  });
});
describe('doctor repair controls', () => {
  it('supports rerun opt-out', async () => {
    const api = doctorApi({ log: 'Get Pages site failed' });
    const result = await doctor(api).scan(
      { repo: 'acme/one' },
      { fix: true, rerun: false, confirm: async () => true }
    );
    expect(result.remaining).toBe(0);
    expect(result.repositories[0].reruns.length).toBe(0);
  });
  it('a dry-run still exits nonzero for remaining findings and writes nothing', async () => {
    const api = doctorApi({ log: 'Get Pages site failed' });
    const result = await doctor(api).scan(
      { repo: 'acme/one' },
      {
        fix: true,
        dryRun: true,
        confirm: async () => {
          throw new Error('must not ask');
        },
      }
    );
    expect(result.exitCode).toBe(1);
    expect(api.writes().length).toBe(0);
  });
  it('requires confirmation and shows the concrete evidence', async () => {
    const api = doctorApi({ log: 'Get Pages site failed' });
    let plan;
    let error;
    try {
      await doctor(api).scan(
        { repo: 'acme/one' },
        {
          fix: true,
          confirm: async (value) => {
            plan = value;
            return false;
          },
        }
      );
    } catch (caught) {
      error = caught;
    }
    expect(error.exitCode).toBe(5);
    expect(plan[0].evidence[0].kind).toBe('log');
    expect(api.writes().length).toBe(0);
  });
  it('leaves ineffective repairs unresolved and never reruns', async () => {
    const api = doctorApi({ log: 'Get Pages site failed', ineffective: true });
    const result = await fix(api);
    expect(result.remaining).toBe(1);
    expect(result.repositories[0].findings[0].error).toContain('confirm');
    expect(result.repositories[0].reruns.length).toBe(0);
  });
  it('disables default setup for advanced workflows', async () => {
    const api = doctorApi({
      files: {
        '.github/workflows/scan.yml': workflow('github/codeql-action/analyze'),
      },
      defaultSetup: 'configured',
    });
    const result = await fix(api);
    expect(result.remaining).toBe(0);
    expect(api.writes()[0].body).toEqual({ state: 'not-configured' });
  });
  it('keeps ambiguous advanced-scanning log errors manual', async () => {
    const api = doctorApi({
      files: {
        '.github/workflows/scan.yml': workflow(
          'github/codeql-action/upload-sarif'
        ),
      },
      log: 'Code scanning is not enabled for this repository',
    });
    const result = await fix(api);
    expect(result.remaining).toBe(1);
    expect(result.repositories[0].findings[0].fixable).toBe(false);
    expect(api.writes().length).toBe(0);
  });
  it('repairs graph and alerts for dependency review using the shared gateways', async () => {
    const api = doctorApi({
      files: {
        '.github/workflows/review.yml': workflow(
          'actions/dependency-review-action'
        ),
      },
    });
    const result = await fix(api);
    expect(result.remaining).toBe(0);
    expect(api.state.features['dependency-graph']).toBe('enabled');
    expect(api.state.features['vulnerability-alerts']).toBe('enabled');
  });
});
describe('doctor discovery and errors', () => {
  it('continues bulk scans after a repository error', async () => {
    const api = doctorApi({ log: 'Get Pages site failed' });
    const result = await doctor(api).scan({ org: 'acme' });
    expect(result.repositories.length).toBe(2);
    expect(result.repositories[0].errors.length).toBe(1);
    expect(result.repositories[1].findings.length).toBe(1);
  });
  it('reports unavailable setting reads as unknown findings with evidence', async () => {
    const api = doctorApi({ log: 'Get Pages site failed' });
    const scanner = createDoctor({
      rest: api.rest,
      pages: {
        status: () => {
          throw new Error('Pages permission missing');
        },
      },
    });
    const report = await scanner.scan({ repo: 'acme/one' });
    const finding = report.repositories[0].findings[0];
    expect(finding.current).toBe('unknown');
    expect(finding.fixable).toBe(false);
    expect(finding.evidence[0].line).toBe(1);
    expect(report.remaining).toBe(1);
  });
  it('reports expired logs as errors with an unresolved scan error', async () => {
    const api = doctorApi({ logsMissing: true });
    const result = await doctor(api).scan({ repo: 'acme/one' });
    expect(result.remaining).toBe(1);
    expect(result.repositories[0].errors[0].reason).toBe('logs-expired');
  });
  it('checks the latest run of each workflow on the default branch', async () => {
    const api = doctorApi({
      conclusion: 'success',
      log: 'Get Pages site failed',
      workflows: [
        { id: 7, path: '.github/workflows/ci.yml' },
        { id: 8, path: '.github/workflows/site.yml' },
      ],
    });
    const result = await doctor(api).scan({ repo: 'acme/one' });
    expect(result.remaining).toBe(0);
    expect(
      api.calls
        .filter((c) => c.path.endsWith('/runs'))
        .every((c) => c.query.branch === 'main')
    ).toBe(true);
  });
  it('supports user scans and the actual doctor CLI JSON and --fix --yes', async () => {
    const github = doctorApi({ log: 'Get Pages site failed' });
    const report = await runCommand(['doctor', '--user', 'acme', '--json'], {
      github,
    });
    expect(report.code).toBe(1);
    expect(JSON.parse(report.output).remaining).toBe(1);
    expect(github.writes().length).toBe(0);
    const fixed = await runCommand(
      ['doctor', 'acme/one', '--fix', '--yes', '--no-rerun', '--json'],
      { github, realPrompt: true }
    );
    expect(fixed.code).toBe(0);
    expect(JSON.parse(fixed.output).remaining).toBe(0);
  });
});
