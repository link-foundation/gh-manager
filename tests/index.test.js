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
  'DOMAINS',
  'EXIT_CODES',
  'FLAG_SPECS',
  'GitHubApiError',
  'ROLES',
  'VISIBILITIES',
  'appPaths',
  'createMatcher',
  'createPackageGateway',
  'createRestClient',
  'describeOperation',
  'diffAccess',
  'ensureAppDir',
  'exitCodeForError',
  'findDomain',
  'globToRegExpSource',
  'isOverBroadPattern',
  'loadStoredConfig',
  'matchPackageNames',
  'openBrowserSession',
  'parseArgs',
  'parsePolicy',
  'resolveAppDir',
  'resolveOwner',
  'resolveSettings',
  'resolveTargets',
  'resolveToken',
  'runCli',
  'saveStoredConfig',
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
});
