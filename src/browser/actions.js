/**
 * Page actions with loud failures.
 *
 * A silently unmatched element is the worst outcome for this tool: it looks
 * like success while nothing happened. Every helper here either performs the
 * action or throws with a screenshot and the page HTML already written to the
 * logs directory.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';
import { MARKED_SELECTOR, markTarget } from './dom.js';

/**
 * Capture failure artifacts and throw a CliError that points at them.
 * @param {Object} session - Browser session
 * @param {Object} options - Failure options
 * @param {string} options.label - Short label used for the artifact file names
 * @param {string} options.message - Human readable failure description
 * @param {Error} [options.cause] - Underlying error
 * @param {number} [options.exitCode] - Exit code to report
 * @returns {Promise<never>} Always throws
 */
export async function failWithArtifacts(
  session,
  { label, message, cause, exitCode = EXIT_CODES.FAILURE }
) {
  const artifacts = await session.capture(label);
  const suffix = artifacts.length > 0 ? ` See ${artifacts.join(' and ')}.` : '';

  throw new CliError(`${message}${suffix}`, exitCode, { cause });
}

/**
 * Navigate to a URL and report the URL that was actually reached.
 * @param {Object} session - Browser session
 * @param {string} url - Destination
 * @returns {Promise<string>} Final URL
 */
export async function gotoUrl(session, url) {
  // GitHub redirects freely (settings paths, sign-in walls), so the navigation
  // is not verified against the requested URL; callers inspect where they
  // actually landed instead.
  await session.commander.goto({ url, verify: false });
  return session.commander.getUrl();
}

/**
 * Fail with the authentication exit code when the profile is signed out.
 * @param {{login: string|null}} state - Page state from readPageState
 * @returns {void}
 */
export function assertSignedIn(state) {
  if (!state.login) {
    throw new CliError(
      'The browser profile is not signed in to GitHub. Run `gh-manager auth login` first.',
      EXIT_CODES.AUTH
    );
  }
}

/**
 * Poll a page reading until it satisfies a condition or the deadline passes.
 *
 * GitHub opens its dialogs asynchronously, so the tool waits for the state it
 * needs and never sleeps for a guessed number of milliseconds.
 * @param {Object} session - Browser session
 * @param {Object} options - Polling options
 * @param {() => Promise<any>} options.read - Reads the current state
 * @param {(value: any) => boolean} options.accept - Decides whether to stop
 * @param {number} [options.timeout] - Total time to keep polling, in ms
 * @param {number} [options.interval] - Delay between readings, in ms
 * @param {() => number} [options.now] - Clock, injectable for tests
 * @returns {Promise<{value: any, accepted: boolean}>} Last reading
 */
export async function pollFor(
  session,
  { read, accept, timeout = 10000, interval = 250, now = Date.now }
) {
  const deadline = now() + timeout;
  let value = await read();

  while (!accept(value)) {
    if (now() >= deadline) {
      return { value, accepted: false };
    }

    await session.commander.wait({ ms: interval, reason: 'waiting for page' });
    value = await read();
  }

  return { value, accepted: true };
}

/**
 * Locate an element, failing with artifacts when nothing matches.
 * @param {Object} session - Browser session
 * @param {Object} options - Lookup options
 * @param {{selectors: string[], texts: string[]}} options.target - Target descriptor
 * @param {string} options.label - Label describing what was being looked for
 * @param {string[]} [options.scopeSelectors] - Restrict the search to these containers
 * @returns {Promise<Object>} Match description from markTarget
 */
export async function requireTarget(
  session,
  { target, label, scopeSelectors = [] }
) {
  const match = await markTarget(session.commander, {
    target,
    scopeSelectors,
  });

  if (!match.found) {
    await failWithArtifacts(session, {
      label,
      message: `GitHub's page does not contain the expected element for "${label}" (${match.reason}). The UI likely changed; selectors live in src/browser/selectors.js.`,
    });
  }

  return match;
}

/**
 * Click an element identified by a target descriptor.
 * @param {Object} session - Browser session
 * @param {Object} options - Click options
 * @param {{selectors: string[], texts: string[]}} options.target - Target descriptor
 * @param {string} options.label - Label describing the click
 * @param {string[]} [options.scopeSelectors] - Restrict the search to these containers
 * @param {boolean} [options.waitForNavigation] - Whether the click navigates
 * @returns {Promise<Object>} Click result from browser-commander
 */
export async function clickTarget(
  session,
  { target, label, scopeSelectors = [], waitForNavigation = false }
) {
  await requireTarget(session, { target, label, scopeSelectors });
  return clickMarked(session, { label, waitForNavigation });
}

/**
 * Click whatever element is currently marked.
 * @param {Object} session - Browser session
 * @param {Object} options - Click options
 * @param {string} options.label - Label describing the click
 * @param {boolean} [options.waitForNavigation] - Whether the click navigates
 * @returns {Promise<Object>} Click result from browser-commander
 */
export async function clickMarked(
  session,
  { label, waitForNavigation = false }
) {
  const result = await session.commander.click({
    selector: MARKED_SELECTOR,
    waitForNavigation,
    verify: false,
  });

  if (!result.clicked && !result.navigated) {
    await failWithArtifacts(session, {
      label,
      message: `Clicking "${label}" did not take effect (${result.reason ?? 'unknown reason'}).`,
    });
  }

  return result;
}

/**
 * Type a value into an element identified by a target descriptor.
 * @param {Object} session - Browser session
 * @param {Object} options - Fill options
 * @param {{selectors: string[], texts: string[]}} options.target - Target descriptor
 * @param {string} options.label - Label describing the field
 * @param {string} options.value - Text to type
 * @param {string[]} [options.scopeSelectors] - Restrict the search to these containers
 * @returns {Promise<void>} Resolves after the field holds the value
 */
export async function fillTarget(
  session,
  { target, label, value, scopeSelectors = [] }
) {
  await requireTarget(session, { target, label, scopeSelectors });

  await session.commander.fill({
    selector: MARKED_SELECTOR,
    text: value,
    // The field may already hold a draft value; replacing it is the point.
    checkEmpty: false,
    verify: false,
  });

  const actual = await session.commander.inputValue({
    selector: MARKED_SELECTOR,
  });

  if (actual !== value) {
    await failWithArtifacts(session, {
      label,
      message: `Could not type the confirmation into "${label}" (field holds ${JSON.stringify(actual)}).`,
    });
  }
}
