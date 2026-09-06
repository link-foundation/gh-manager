/**
 * The gh-manager library surface.
 *
 * The CLI is one consumer of these modules; importing them directly is what
 * makes gh-manager usable from a release script that already knows which
 * packages it publishes.
 */

export { runCli } from './cli/main.js';
export { parseArgs, FLAG_SPECS } from './cli/args.js';
export { DOMAINS, findDomain } from './domains/index.js';
export { CliError, EXIT_CODES, exitCodeForError } from './exit-codes.js';
export {
  DEFAULT_CONFIG,
  CONFIGURABLE_KEYS,
  appPaths,
  ensureAppDir,
  loadStoredConfig,
  resolveAppDir,
  resolveOwner,
  resolveSettings,
  saveStoredConfig,
  writeStoredConfig,
} from './config.js';
export {
  createMatcher,
  globToRegExpSource,
  isOverBroadPattern,
  matchPackageNames,
  resolveTargets,
} from './patterns.js';
export { createRestClient, GitHubApiError } from './github/rest.js';
export { resolveToken } from './github/token.js';
export { createPackageGateway } from './packages/gateway.js';
export {
  describeOperation,
  diffAccess,
  parsePolicy,
  validateRole,
} from './permissions/policy.js';
export { openBrowserSession, withBrowserSession } from './browser/session.js';
export { ROLES, VISIBILITIES } from './browser/selectors.js';
