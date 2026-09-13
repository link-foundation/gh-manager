/**
 * The repository's "Code security and analysis" settings page.
 *
 * The dependency graph toggle lives here and nowhere else: GitHub publishes no
 * REST endpoint, no GraphQL mutation, and no `gh` command for it, which is why
 * a repository whose dependency graph is off fails `actions/dependency-review`
 * with "Dependency graph is not enabled" and leaves nothing to automate. The
 * other toggles on the page do have endpoints, and this driver is their
 * fallback for the cases where the token is refused but the signed-in browser
 * profile is not.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoSlug } from '../github/repo.js';
import { SECURITY_FEATURES, stateName } from '../security/features.js';
import {
  assertSignedIn,
  clickMarked,
  failWithArtifacts,
  gotoUrl,
  pollFor,
} from './actions.js';
import { inspectSecurityRows, readPageState } from './dom.js';
import {
  SECURITY_CONTROLS,
  SECURITY_LOCK_PHRASES,
  repoSecuritySettingsUrl,
} from './selectors.js';

/** How long to wait for a clicked toggle to show its new state. */
const SETTLE_TIMEOUT_MS = 10000;

/**
 * Read every security row of the open page, optionally marking one control.
 * @param {Object} session - Browser session
 * @param {{feature: string, action: string}|null} mark - Control to mark
 * @returns {Promise<{rows: Object<string, Object>, marked: Object|null}>} Page reading
 */
async function inspect(session, mark) {
  const result = await inspectSecurityRows(session.commander, {
    features: SECURITY_FEATURES,
    controls: SECURITY_CONTROLS,
    lockPhrases: SECURITY_LOCK_PHRASES,
    mark,
  });

  return {
    rows: Object.fromEntries(result.rows.map((row) => [row.id, row])),
    marked: result.marked,
  };
}

/**
 * Open a repository's code security settings and read its toggles.
 *
 * A page that shows none of the known rows is treated as a failure with
 * artifacts: that is what GitHub renders for an account without admin rights,
 * and reporting "everything is disabled" for it would be a lie.
 * @param {Object} session - Browser session
 * @param {Object} options - Options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.log - Logger
 * @returns {Promise<Object<string, Object>>} Row state by feature id
 */
export async function readSecurityFeatures(session, { repo, log }) {
  const landed = await gotoUrl(session, repoSecuritySettingsUrl(repo));
  const state = await readPageState(session.commander);
  assertSignedIn(state);

  if (state.notFound) {
    throw new CliError(
      `${repoSlug(repo)} does not exist, or its settings are not visible to ${state.login}`,
      EXIT_CODES.FAILURE
    );
  }

  const { rows } = await inspect(session, null);

  if (!Object.values(rows).some((row) => row.found)) {
    await failWithArtifacts(session, {
      label: `security settings of ${repo.name}`,
      message: `Could not read the code security settings of ${repoSlug(repo)}: the page shows none of the expected toggles. The account may lack admin rights on the repository, or the page layout changed; selectors live in src/browser/selectors.js.`,
    });
  }

  log.debug(`code security settings open: ${landed}`);
  return rows;
}

/**
 * Flip one security toggle on the page.
 *
 * The state the page reports afterwards is returned and never assumed: the
 * caller confirms the change through the API where an endpoint exists, and
 * falls back to this reading where none does.
 * @param {Object} session - Browser session
 * @param {Object} options - Operation options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.feature - Feature definition
 * @param {boolean} options.enabled - Desired state
 * @param {Object} options.log - Logger
 * @returns {Promise<{changed: boolean, reported: string|null}>} Outcome
 */
export async function setSecurityFeature(
  session,
  { repo, feature, enabled, log }
) {
  const action = enabled ? 'enable' : 'disable';
  const label = `${action} ${feature.label} on ${repoSlug(repo)}`;
  const rows = await readSecurityFeatures(session, { repo, log });
  const row = rows[feature.id];

  if (!row.found) {
    await failWithArtifacts(session, {
      label,
      message: `GitHub's code security page for ${repoSlug(repo)} shows no "${feature.label}" row (${row.reason}), so nothing was clicked.`,
    });
  }

  if (row.state === stateName(enabled)) {
    log.debug(`${feature.label} already reads ${row.state} on the page`);
    return { changed: false, reported: row.state };
  }

  if (row.locked) {
    await failWithArtifacts(session, {
      label,
      message: `"${feature.label}" is not ${repoSlug(repo)}'s to change: the control is governed by an organization or enterprise policy.`,
    });
  }

  const { marked } = await inspect(session, { feature: feature.id, action });

  if (!marked.found) {
    await failWithArtifacts(session, {
      label,
      message: `The "${feature.label}" row of ${repoSlug(repo)} carries no "${action}" control (${marked.reason}).`,
    });
  }

  await clickMarked(session, { label });

  const { value } = await pollFor(session, {
    read: async () => (await inspect(session, null)).rows[feature.id],
    accept: (current) => current.state === stateName(enabled),
    timeout: SETTLE_TIMEOUT_MS,
  });

  return { changed: true, reported: value.found ? value.state : null };
}
