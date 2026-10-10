/**
 * The public library surface.
 *
 * The CLI is only one consumer of these modules: a release script that already
 * knows which packages it publishes imports them directly, so the entry point
 * has to keep exporting them.
 */

import { describe, it, expect } from 'test-anywhere';

import * as ghManager from '../src/index.js';

const EXPECTED_EXPORTS = [
  'CONFIGURABLE_KEYS',
  'CliError',
  'DEFAULT_CONFIG',
  'DEFAULT_PROTECTION_RULES',
  'DOMAINS',
  'EXIT_CODES',
  'FLAG_SPECS',
  'GitHubApiError',
  'ROLES',
  'SECURITY_FEATURES',
  'SECURITY_FEATURE_IDS',
  'VISIBILITIES',
  'appPaths',
  'auditWorkflows',
  'createMatcher',
  'createPackageGateway',
  'createProtectionManager',
  'createRepoManager',
  'createRestClient',
  'createRunManager',
  'createSecretHealth',
  'createSecretManager',
  'createSecurityGateway',
  'describeOperation',
  'diffAccess',
  'ensureAppDir',
  'exitCodeForError',
  'findDomain',
  'findSecurityFeature',
  'githubAppPlan',
  'globToRegExpSource',
  'health',
  'isOverBroadPattern',
  'loadStoredConfig',
  'matchPackageNames',
  'openBrowserSession',
  'parseArgs',
  'parsePolicy',
  'parseRepoSpec',
  'repoSlug',
  'repos',
  'resolveAppDir',
  'resolveOwner',
  'resolveSettings',
  'resolveTargets',
  'resolveToken',
  'runCli',
  'runs',
  'saveStoredConfig',
  'secrets',
  'validateRole',
  'withBrowserSession',
  'writeStoredConfig',
];

describe('library surface', () => {
  it('exports the documented entry points', () => {
    expect(Object.keys(ghManager).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it('exports the pattern helpers as callable functions', () => {
    expect(typeof ghManager.matchPackageNames).toBe('function');
    expect(
      ghManager.matchPackageNames(['box', 'gh-manager'], { pattern: 'box*' })
    ).toEqual(['box']);
  });

  it('names the exit codes the CLI documents', () => {
    expect(ghManager.EXIT_CODES).toEqual({
      SUCCESS: 0,
      FAILURE: 1,
      USAGE: 2,
      AUTH: 3,
      NO_MATCHES: 4,
      ABORTED: 5,
      VERIFICATION_FAILED: 6,
    });
  });

  it('lists the visibilities and roles GitHub offers', () => {
    expect(ghManager.VISIBILITIES).toEqual(['public', 'private', 'internal']);
    expect(ghManager.ROLES).toEqual(['read', 'write', 'admin']);
  });

  it('names the code security settings it can manage', () => {
    expect(ghManager.SECURITY_FEATURE_IDS).toEqual([
      'dependency-graph',
      'vulnerability-alerts',
      'automated-security-fixes',
      'secret-scanning',
      'push-protection',
    ]);
    expect(ghManager.findSecurityFeature('dependency-graph').label).toBe(
      'Dependency graph'
    );
  });
});
