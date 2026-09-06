/**
 * Runs whole command lines against a fake GitHub.
 *
 * `runCli` returns an exit code and never calls `process.exit`, so a test can
 * run the real argument parsing, the real gateway, and the real page drivers in
 * process. Only the four seams the CLI already injects are replaced here: the
 * token, the REST client, the browser session, and the confirmation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../../src/cli/main.js';
import { createFakeSession } from './fake-browser.js';
import { listingRoutes, packagePages } from './github-pages.js';

/**
 * Build a GitHub whose API and pages describe the same packages.
 *
 * The API reads from the state the page drivers change, which is what makes a
 * verified change meaningful here: the visibility the CLI reports has to be
 * the one the browser actually produced.
 * @param {Array<Object>} specs - Packages to serve, as packagePages options
 * @param {Object} [options] - GitHub options
 * @param {boolean} [options.apiListing] - Whether the REST listing answers
 * @param {boolean} [options.hasToken] - Whether a token is configured
 * @returns {{rest: Object, routes: Object, states: Map<string, Object>}} GitHub
 */
export function fakeGitHub(specs, { apiListing = true, hasToken = true } = {}) {
  const pages = specs.map((spec) =>
    packagePages({ visibility: 'private', ...spec })
  );
  const states = new Map(
    specs.map((spec, index) => [spec.packageName, pages[index].state])
  );

  const routes = Object.assign(
    {},
    ...pages.map((entry) => entry.routes),
    listingRoutes([specs.map((spec) => spec.packageName)])
  );

  /**
   * Read the packages the API can currently see.
   * @returns {Array<Object>} Package payloads
   */
  function live() {
    return [...states]
      .filter(([, state]) => !state.deleted)
      .map(([name, state]) => ({ name, visibility: state.visibility }));
  }

  const rest = {
    hasToken,

    /**
     * @returns {Promise<Array<Object>>} Packages, or nothing when the listing
     *   endpoint answers empty for this token
     */
    async listPackages() {
      return apiListing && hasToken ? live() : [];
    },

    /**
     * @param {Object} options - Coordinates
     * @param {string} options.packageName - Package name
     * @returns {Promise<Object|null>} Package payload, or null when gone
     */
    async getPackage({ packageName }) {
      if (!hasToken) {
        return null;
      }

      return live().find((entry) => entry.name === packageName) ?? null;
    },
  };

  return { rest, routes, states };
}

/**
 * Run one command line against a fake GitHub.
 * @param {string[]} argv - Command line, without the executable
 * @param {Object} [options] - Run options
 * @param {Object} [options.github] - Result of fakeGitHub
 * @param {Function} [options.confirm] - Confirmation stand-in
 * @returns {Promise<Object>} Exit code, output, questions asked, and sessions
 */
export async function runCommand(argv, { github, confirm } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gh-manager-cli-'));
  const out = [];
  const err = [];
  const sessions = [];
  const asked = [];

  try {
    const code = await runCli(argv, {
      stdout: (line) => out.push(String(line)),
      stderr: (line) => err.push(String(line)),
      env: {},
      home,
      deps: {
        resolveToken: () => ({
          token: github?.rest.hasToken === false ? null : 'test-token',
          source: '--token',
        }),
        createRest: () => github?.rest,
        openSession: async () => {
          const session = createFakeSession({ routes: github?.routes ?? {} });
          sessions.push(session);
          return session;
        },
        confirm: async (question) => {
          asked.push(question);
          return confirm ? confirm(question) : true;
        },
      },
    });

    return {
      code,
      sessions,
      asked,
      output: out.join('\n'),
      errors: err.join('\n'),
    };
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}
