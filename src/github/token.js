/**
 * API token discovery.
 *
 * The browser session and the API token are independent: the browser performs
 * the actions the API cannot, the token is used for the fast, reliable reads
 * and for verifying that an action landed. An existing `gh` login is reused
 * when present so there is nothing extra to set up.
 */

import { execFileSync } from 'node:child_process';

/** Environment variables checked, in order, before falling back to `gh`. */
export const TOKEN_ENVIRONMENT_VARIABLES = [
  'GH_MANAGER_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
];

/**
 * Read the token stored by the GitHub CLI.
 * @returns {string|null} Token, or null when `gh` is missing or logged out
 */
function readGhCliToken() {
  try {
    const output = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const token = output.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the API token to use, reporting where it came from.
 * @param {Object} [options] - Resolution inputs
 * @param {string} [options.token] - Value of --token
 * @param {Object} [options.env] - Environment variables
 * @param {() => string|null} [options.readCliToken] - `gh auth token` reader
 * @returns {{token: string|null, source: string|null}} Resolved token
 */
export function resolveToken({
  token,
  env = process.env,
  readCliToken = readGhCliToken,
} = {}) {
  if (token) {
    return { token, source: '--token' };
  }

  for (const variable of TOKEN_ENVIRONMENT_VARIABLES) {
    if (env[variable]) {
      return { token: env[variable], source: variable };
    }
  }

  const cliToken = readCliToken();

  if (cliToken) {
    return { token: cliToken, source: 'gh auth token' };
  }

  return { token: null, source: null };
}
