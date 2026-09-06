/**
 * Managed browser session.
 *
 * The session is a real installed Chrome (or Edge, Brave, Chromium) started by
 * browser-commander with a dedicated `--user-data-dir` inside the application
 * directory. That profile is what makes a single interactive login enough:
 * cookies, SSO, and 2FA state persist between runs, which no token can do.
 *
 * browser-commander is imported lazily so that parsing a command line, printing
 * help, or running the unit tests never loads a browser stack.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';
import { captureFailureArtifacts } from '../logging.js';

/**
 * Default loader for browser-commander, replaceable in tests.
 * @returns {Promise<Object>} The browser-commander module
 */
function importBrowserCommander() {
  return import('browser-commander');
}

/**
 * Start a browser session bound to the managed profile.
 * @param {Object} options - Session options
 * @param {Object} options.settings - Effective settings, including paths
 * @param {Object} options.log - Logger
 * @param {Function} [options.loadModule] - browser-commander loader override
 * @returns {Promise<Object>} Session with commander, page, capture, and close
 */
export async function openBrowserSession({
  settings,
  log,
  loadModule = importBrowserCommander,
}) {
  const { launchRealBrowser, makeBrowserCommander } = await loadModule();

  log.debug(
    `launching ${settings.channel} via ${settings.engine} with profile ${settings.profileDir}`
  );

  let connection;

  try {
    connection = await launchRealBrowser({
      engine: settings.engine,
      channel: settings.channel,
      userDataDir: settings.profileDir,
      headless: Boolean(settings.headless),
    });
  } catch (error) {
    throw new CliError(
      `Cannot start ${settings.channel}: ${error.message}. Install the browser, or pass --channel (chrome, msedge, brave, chromium).`,
      EXIT_CODES.FAILURE,
      { cause: error }
    );
  }

  const commander = makeBrowserCommander({
    page: connection.page,
    verbose: Boolean(settings.verbose),
  });

  return {
    commander,
    connection,
    page: connection.page,

    /**
     * Write a screenshot and the page HTML for a failed step.
     * @param {string} label - Label describing the failure
     * @returns {Promise<string[]>} Paths of the artifacts written
     */
    capture(label) {
      return captureFailureArtifacts({
        logsDir: settings.logsDir,
        page: connection.page,
        label,
      });
    },

    /**
     * Shut the session down, tolerating an already-closed browser.
     * @returns {Promise<void>} Resolves when cleanup finished
     */
    async close() {
      try {
        await commander.destroy();
      } catch (error) {
        log.debug(`commander cleanup failed: ${error.message}`);
      }

      try {
        await connection.browser.close();
      } catch (error) {
        log.debug(`browser close failed: ${error.message}`);
      }

      if (connection.browserProcess?.exitCode === null) {
        connection.browserProcess.kill();
      }
    },
  };
}

/**
 * Run a callback with a browser session and always close it afterwards.
 * @param {Object} options - Session options (see openBrowserSession)
 * @param {(session: Object) => Promise<any>} callback - Work to run
 * @returns {Promise<any>} Whatever the callback returned
 */
export async function withBrowserSession(options, callback) {
  const session = await openBrowserSession(options);

  try {
    return await callback(session);
  } finally {
    await session.close();
  }
}
