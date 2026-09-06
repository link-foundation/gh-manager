/**
 * The `auth` domain: one interactive login, reused by every later run.
 *
 * gh-manager never handles a password. The operator signs in once in the
 * managed Chrome profile — including SSO and 2FA, which a token cannot carry —
 * and the profile directory keeps that session for the following commands.
 */

import { rm } from 'node:fs/promises';

import { gotoUrl, pollFor } from '../browser/actions.js';
import { readPageState, readSignedInLogin } from '../browser/dom.js';
import { homeUrl, loginUrl } from '../browser/selectors.js';
import { CliError, EXIT_CODES } from '../exit-codes.js';

/** How long `auth login` waits for the operator to finish signing in. */
const LOGIN_TIMEOUT_SECONDS = 300;

/** How often the login page is checked while waiting. */
const LOGIN_POLL_INTERVAL_MS = 2000;

/**
 * Read the account the managed profile is signed in as.
 * @param {Object} context - Run context
 * @returns {Promise<{session: Object, login: string|null}>} Session and account
 */
async function readSession(context) {
  const session = await context.getSession();
  await gotoUrl(session, homeUrl());
  const state = await readPageState(session.commander);
  return { session, login: state.login };
}

/**
 * Sign in to GitHub in the managed browser profile.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function login(context) {
  if (context.settings.headless) {
    throw new CliError(
      'Signing in needs a visible browser window; run `gh-manager auth login` without --headless.',
      EXIT_CODES.USAGE
    );
  }

  const { session, login: existing } = await readSession(context);

  if (existing) {
    context.log.info(`Already signed in as ${existing}.`);
    return EXIT_CODES.SUCCESS;
  }

  const seconds = context.flags.timeout ?? LOGIN_TIMEOUT_SECONDS;
  await gotoUrl(session, loginUrl());
  context.log.info(
    `Sign in to GitHub in the browser window that just opened. Waiting up to ${seconds}s...`
  );

  const { value, accepted } = await pollFor(session, {
    read: () => readSignedInLogin(session.commander),
    accept: (account) => Boolean(account),
    timeout: seconds * 1000,
    interval: LOGIN_POLL_INTERVAL_MS,
  });

  if (!accepted) {
    throw new CliError(
      `No GitHub session appeared within ${seconds}s. Run the command again, or raise the wait with --timeout <seconds>.`,
      EXIT_CODES.AUTH
    );
  }

  context.log.info(
    `Signed in as ${value}. The profile in ${context.settings.profileDir} will be reused by later commands.`
  );
  return EXIT_CODES.SUCCESS;
}

/**
 * Report whether the profile is signed in and which API token is in use.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function status(context) {
  const { login: account } = await readSession(context);

  context.log.info(`Application directory: ${context.settings.appDir}`);
  context.log.info(`Browser profile:       ${context.settings.profileDir}`);
  context.log.info(
    `API token:             ${context.token.token ? `present (from ${context.token.source})` : 'none (reads fall back to the browser)'}`
  );
  context.log.info(
    `Browser session:       ${account ? `signed in as ${account}` : 'signed out'}`
  );

  if (!account) {
    context.log.error('Not signed in. Run `gh-manager auth login`.');
    return EXIT_CODES.AUTH;
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * Delete the managed browser profile, which ends the stored session.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function logout(context) {
  const { profileDir } = context.settings;
  context.log.info(`This deletes the browser profile in ${profileDir}.`);

  if (context.flags.dryRun) {
    context.log.info('Dry run: the profile was kept.');
    return EXIT_CODES.SUCCESS;
  }

  if (!(await context.confirm('Sign out and delete the profile?'))) {
    throw new CliError('Aborted: the profile was kept.', EXIT_CODES.ABORTED);
  }

  await rm(profileDir, { recursive: true, force: true });
  context.log.info('Signed out. Run `gh-manager auth login` to sign in again.');
  return EXIT_CODES.SUCCESS;
}

/** The `auth` command domain. */
export const authDomain = {
  name: 'auth',
  summary: 'Sign in to GitHub once and reuse that session',
  usage: [
    'gh-manager auth login    Open a browser window and wait for the sign-in',
    'gh-manager auth status   Show the signed-in account and the API token in use',
    'gh-manager auth logout   Delete the managed browser profile',
  ],
  verbs: {
    login: { summary: 'Sign in and store the session', run: login },
    status: { summary: 'Show the current session', run: status },
    logout: { summary: 'Delete the stored session', run: logout },
  },
};
