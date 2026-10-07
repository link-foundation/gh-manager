/**
 * The run context handed to every command.
 *
 * It resolves settings once, keeps at most one browser session per run (opened
 * lazily, so commands that only read through the API never start a browser),
 * and lets tests replace the browser, the API, and the confirmation prompt.
 */

import { openBrowserSession } from '../browser/session.js';
import { ensureAppDir, resolveOwner, resolveSettings } from '../config.js';
import { createRestClient } from '../github/rest.js';
import { resolveToken } from '../github/token.js';
import { createLogger } from '../logging.js';
import { createPackageGateway } from '../packages/gateway.js';
import { createSecurityGateway } from '../security/gateway.js';
import { createConfirm } from './prompt.js';
import { CliError, EXIT_CODES } from '../exit-codes.js';

/**
 * Build the context for one command invocation.
 * @param {Object} options - Context options
 * @param {string[]} [options.targets] - Positional arguments after the verb
 * @param {Object} [options.flags] - Parsed command line flags
 * @param {Object} [options.env] - Environment variables
 * @param {string} [options.home] - Home directory override
 * @param {Function} [options.stdout] - Standard output sink
 * @param {Function} [options.stderr] - Standard error sink
 * @param {Object} [options.deps] - Injectable dependencies, used by tests
 * @returns {Object} Run context
 */
export function createRunContext({
  targets = [],
  flags = {},
  env = process.env,
  home,
  stdout,
  stderr,
  deps = {},
} = {}) {
  const settings = resolveSettings({ flags, env, home });
  const log = createLogger({
    verbose: Boolean(flags.verbose),
    stdout,
    stderr,
  });

  const token = (deps.resolveToken ?? resolveToken)({
    token: flags.token,
    env,
  });
  const rest = (deps.createRest ?? createRestClient)({ token: token.token });
  const openSession = deps.openSession ?? openBrowserSession;

  let sessionPromise = null;
  let gateway = null;
  const securityGateways = new Map();

  /**
   * Open the browser session, or return the one this run already opened.
   * @returns {Promise<Object>} Browser session
   */
  function getSession() {
    if (!sessionPromise) {
      ensureAppDir(settings.appDir);
      sessionPromise = openSession({ settings, log });
    }

    return sessionPromise;
  }

  return {
    targets,
    flags,
    settings,
    log,
    rest,
    token,
    getSession,
    readSecret:
      deps.readSecret ??
      (async () => {
        if (process.stdin.isTTY) {
          throw new CliError(
            'Pipe the secret value through stdin.',
            EXIT_CODES.USAGE
          );
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of process.stdin) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 48 * 1024 + 2) {
            throw new CliError(
              'Secret stdin exceeds 48 KiB.',
              EXIT_CODES.USAGE
            );
          }
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('utf8');
      }),

    confirm: deps.confirm ?? createConfirm({ assumeYes: Boolean(flags.yes) }),

    /**
     * Resolve which account the command acts on.
     * @returns {{scope: string, name: string}} Owner descriptor
     */
    owner() {
      return resolveOwner(settings);
    },

    /**
     * The package gateway, created on first use.
     * @returns {Object} Package gateway
     */
    packages() {
      gateway ??= createPackageGateway({
        owner: this.owner(),
        packageType: settings.packageType,
        rest,
        log,
        getSession,
      });

      return gateway;
    },

    /**
     * The security gateway of one repository, created on first use.
     * @param {{owner: string, name: string}} repo - Repository
     * @returns {Object} Security gateway
     */
    security(repo) {
      const key = `${repo.owner}/${repo.name}`;

      if (!securityGateways.has(key)) {
        securityGateways.set(
          key,
          (deps.createSecurity ?? createSecurityGateway)({
            repo,
            rest,
            log,
            getSession,
          })
        );
      }

      return securityGateways.get(key);
    },

    /**
     * Close the browser session if one was opened.
     * @returns {Promise<void>} Resolves after closing the browser
     */
    async close() {
      if (!sessionPromise) {
        return;
      }

      try {
        const session = await sessionPromise;
        await session.close();
      } catch (error) {
        log.debug(`session cleanup skipped: ${error.message}`);
      }
    },
  };
}
