import { describe, it, expect } from 'test-anywhere';
import {
  findSecurityFeature,
  securityDefault,
} from '../src/security/features.js';
import {
  readFeatureThroughApi,
  writeFeatureThroughApi,
} from '../src/security/api.js';
import { createSecurityGateway } from '../src/security/gateway.js';
import { createLogger } from '../src/logging.js';
import { securityGitHub } from './fixtures/github-security-pages.js';
import { createFakeSession } from './fixtures/fake-browser.js';
import { runCommand } from './fixtures/cli-runner.js';

const repo = { owner: 'acme', name: 'one' };
const log = createLogger({ stdout: () => {}, stderr: () => {} });

describe('remaining security settings', () => {
  for (const [id, path, kind] of [
    [
      'private-vulnerability-reporting',
      'private-vulnerability-reporting',
      'reporting',
    ],
    [
      'non-provider-patterns',
      'secret_scanning_non_provider_patterns',
      'analysis',
    ],
    ['validity-checks', 'secret_scanning_validity_checks', 'analysis'],
    [
      'code-scanning-default-setup',
      'code-scanning/default-setup',
      'default-setup',
    ],
  ]) {
    it(`reads, enables, and disables ${id} with the documented API`, async () => {
      const feature = findSecurityFeature(id);
      const calls = [];
      const rest = {
        hasToken: true,
        send: async (url, options = {}) => {
          calls.push({ url, ...options });
          return {
            ok: true,
            status: 200,
            body:
              kind === 'analysis'
                ? { security_and_analysis: { [path]: { status: 'enabled' } } }
                : kind === 'reporting'
                  ? { enabled: true }
                  : { state: 'configured' },
          };
        },
      };
      expect((await readFeatureThroughApi(rest, { repo, feature })).state).toBe(
        'enabled'
      );
      for (const enabled of [true, false]) {
        expect(
          (await writeFeatureThroughApi(rest, { repo, feature, enabled }))
            .written
        ).toBe(true);
        const call = calls.at(-1);
        expect(call.url).toBe(
          `/repos/acme/one${kind === 'analysis' ? '' : `/${path}`}`
        );
        expect(call.method).toBe(
          kind === 'reporting' ? (enabled ? 'PUT' : 'DELETE') : 'PATCH'
        );
        if (kind === 'default-setup') {
          expect(call.body.state).toBe(
            enabled ? 'configured' : 'not-configured'
          );
        }
        if (kind === 'analysis') {
          expect(call.body.security_and_analysis[path].status).toBe(
            enabled ? 'enabled' : 'disabled'
          );
        }
      }
    });
  }
  for (const id of ['non-provider-patterns', 'validity-checks']) {
    it(`refuses ${id} until secret scanning is enabled`, async () => {
      const github = securityGitHub();
      const result = await runCommand(
        ['security', id, 'link-foundation/gh-manager', '--enable', '--yes'],
        { github }
      );
      expect(result.code).toBe(1);
      expect(result.errors).toContain('needs "Secret scanning"');
      expect(github.state.writes.length).toBe(0);
    });
  }
  for (const id of [
    'grouped-security-updates',
    'dependabot-self-hosted-runners',
    'copilot-autofix',
  ]) {
    it(`writes and verifies browser-only ${id}`, async () => {
      const github = securityGitHub({
        states: { 'automated-security-fixes': 'enabled' },
      });
      const gateway = createSecurityGateway({
        repo: github.repo,
        rest: github.rest,
        log,
        getSession: async () => createFakeSession({ routes: github.routes }),
        verificationTimeout: 0,
      });
      const result = await gateway.setFeature({
        feature: findSecurityFeature(id),
        enabled: true,
      });
      expect(result.changedBy).toBe('browser');
      expect(result.verifiedBy).toBe('page');
      expect(github.state.features[id]).toBe('enabled');
    });
  }
});
describe('security safety and status', () => {
  for (const visibility of ['public', 'private', 'internal']) {
    it(`uses documented product defaults for ${visibility} repositories`, () => {
      const defaults = (id) =>
        securityDefault(findSecurityFeature(id), visibility);
      expect(defaults('dependabot-actions-runners')).toBe('enabled');
      expect(defaults('copilot-autofix')).toBe('enabled');
      expect(defaults('dependency-graph')).toBe(
        visibility === 'public' ? 'enabled' : 'disabled'
      );
      expect(defaults('private-vulnerability-reporting')).toBe('disabled');
      expect(securityDefault({ id: 'future-setting' }, visibility)).toBe(
        'unknown'
      );
    });
  }
  it('retains unknown defaults when visibility is unknown', () => {
    expect(
      securityDefault(findSecurityFeature('copilot-autofix'), 'unknown')
    ).toBe('unknown');
  });
  it('refuses default setup before writing when an advanced workflow exists', async () => {
    const github = securityGitHub();
    const rest = {
      ...github.rest,
      request: async (path) =>
        path.includes('/contents/.github/workflows/')
          ? {
              encoding: 'base64',
              content: Buffer.from(
                'jobs:\n  scan:\n    steps:\n      - uses: github/codeql-action/analyze@v4\n'
              ).toString('base64'),
            }
          : [{ name: 'security.yml', type: 'file' }],
    };
    const gateway = createSecurityGateway({
      repo: github.repo,
      rest,
      log,
      getSession: async () => createFakeSession({ routes: github.routes }),
      verificationTimeout: 0,
    });
    let error;
    try {
      await gateway.setFeature({
        feature: findSecurityFeature('code-scanning-default-setup'),
        enabled: true,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.message).toContain('advanced');
    expect(github.state.writes.length).toBe(0);
  });
  it('keeps prerequisites when a known feature is selected by its page heading', async () => {
    const github = securityGitHub();
    const result = await runCommand(
      [
        'security',
        'page-setting',
        'link-foundation/gh-manager',
        '--name',
        'Non-provider patterns',
        '--enable',
        '--yes',
      ],
      { github }
    );
    expect(result.code).toBe(1);
    expect(github.state.writes.length).toBe(0);
  });
  it('includes defaults and all known page-only rows in status', async () => {
    const github = securityGitHub();
    const result = await runCommand(
      ['security', 'status', 'link-foundation/gh-manager', '--json'],
      { github }
    );
    expect(result.code).toBe(0);
    const features = JSON.parse(result.output)[0].features;
    expect(
      features.find((f) => f.id === 'dependency-graph').differsFromDefault
    ).toBe(true);
    expect(
      features.find((f) => f.id === 'private-vulnerability-reporting')
        .defaultState
    ).toBe('disabled');
    expect(features.some((f) => f.id === 'copilot-autofix')).toBe(true);
  });
});
