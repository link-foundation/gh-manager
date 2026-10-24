/**
 * The gateway behind `gh-manager security`.
 *
 * It follows the rule the rest of the tool lives by: read through the API,
 * write through whichever half of GitHub accepts the write, and then re-read
 * through the API to prove that the change landed. The dependency graph is the
 * feature that forces the browser half — it has no endpoint at all — and the
 * others use the browser only when the API refuses a token that the signed-in
 * profile would have been allowed to use.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';
import { workflowFiles } from '../secrets/workflows.js';
import { workflowRequirements } from '../doctor/workflows.js';
import { repoPath } from '../github/rest.js';
import { repoSlug } from '../github/repo.js';
import {
  readSecurityFeatures,
  setSecurityFeature,
} from '../browser/security-settings.js';
import {
  VERIFICATION_INTERVAL_MS,
  VERIFICATION_TIMEOUT_MS,
  pollUntil,
} from '../verification.js';
import {
  canWriteThroughApi,
  readFeatureThroughApi,
  writeFeatureThroughApi,
} from './api.js';
import {
  SECURITY_FEATURES,
  findSecurityFeature,
  stateName,
  securityDefault,
} from './features.js';

/**
 * Build the reads the gateway performs: the API lookups, the page reading, and
 * the verification loop that decides whether a change landed.
 * @param {Object} options - Reader options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.rest - REST client
 * @param {Object} options.log - Logger
 * @param {() => Promise<Object>} options.getSession - Opens (or reuses) a browser session
 * @param {number} options.verificationTimeout - How long to wait for the API to agree
 * @returns {Object} Reading helpers
 */
function createSecurityReaders({
  repo,
  rest,
  log,
  getSession,
  verificationTimeout,
}) {
  const slug = repoSlug(repo);
  let pageRows = null;
  let pageError = null;

  /**
   * Read every row of the settings page, keeping the reading for this run.
   *
   * The page shows every feature together, so a status listing falling back to
   * it opens the browser a single time.
   * @param {boolean} [fresh] - Force a new reading
   * @returns {Promise<Object<string, Object>>} Rows by feature id
   */
  async function readPage(fresh = false) {
    if (pageError && !fresh) {
      throw pageError;
    }
    if (fresh || !pageRows) {
      try {
        const session = await getSession();
        pageRows = await readSecurityFeatures(session, { repo, log });
        pageError = null;
      } catch (error) {
        pageError = error;
        throw error;
      }
    }

    return pageRows;
  }

  /**
   * Read one feature's state from the settings page.
   * @param {Object} feature - Feature definition
   * @param {boolean} [fresh] - Force a new reading
   * @returns {Promise<{state: string, locked?: boolean, reason?: string}>} State
   */
  async function readThroughPage(feature, fresh = false) {
    const row = (await readPage(fresh))[feature.id];

    return row?.found
      ? { state: row.state, locked: Boolean(row.locked) }
      : { state: 'unknown', reason: row?.reason ?? 'no-row' };
  }

  /**
   * Read one feature, preferring the API and falling back to the page.
   * @param {Object} feature - Feature definition
   * @returns {Promise<{id: string, label: string, state: string, source: string, reason?: string}>} Status
   */
  async function readFeature(feature) {
    const fromApi = await readFeatureThroughApi(rest, { repo, feature });

    if (fromApi.state !== 'unknown') {
      return {
        id: feature.id,
        label: feature.label,
        ...fromApi,
        source: 'api',
      };
    }

    log.debug(`API cannot read ${feature.id} of ${slug}: ${fromApi.reason}`);
    const fromPage = await readThroughPage(feature);

    return {
      id: feature.id,
      label: feature.label,
      ...fromPage,
      source: fromPage.state === 'unknown' ? 'none' : 'page',
    };
  }

  /**
   * Re-read one feature through the API until it reports the wanted state.
   * @param {Object} feature - Feature definition
   * @param {boolean} enabled - Wanted state
   * @returns {Promise<{checked: boolean, verified: boolean, state: string}>} Result
   */
  async function verifyThroughApi(feature, enabled) {
    if (!feature.read || !rest.hasToken) {
      return { checked: false, verified: false, state: 'unknown' };
    }
    let sawConclusiveRead = false;

    const { value, accepted } = await pollUntil({
      read: async () => {
        const outcome = await readFeatureThroughApi(rest, { repo, feature });
        sawConclusiveRead = sawConclusiveRead || outcome.state !== 'unknown';
        return outcome;
      },
      accept: (outcome) => outcome.state === stateName(enabled),
      timeout: verificationTimeout,
      interval: VERIFICATION_INTERVAL_MS,
    });

    return {
      checked: accepted || sawConclusiveRead,
      verified: accepted,
      state: value.state,
    };
  }

  /**
   * Refuse a change GitHub would reject for a missing prerequisite.
   *
   * Dependabot security updates need the alerts, and push protection needs
   * secret scanning. GitHub answers a 422 with no explanation in those cases,
   * so the requirement is named here while nothing has been touched yet.
   * @param {Object} feature - Feature definition
   * @param {boolean} enabled - Wanted state
   * @returns {Promise<void>} Resolves when the change may proceed
   */
  async function requirePrerequisite(feature, enabled) {
    if (!enabled || !feature.requires) {
      return;
    }

    const required = findSecurityFeature(feature.requires);
    const status = await readFeature(required);

    if (status.state !== 'enabled') {
      throw new CliError(
        `"${feature.label}" needs "${required.label}", which is ${status.state} for ${slug}. Run \`gh-manager security ${required.id} ${slug} --enable\` first.`,
        EXIT_CODES.FAILURE
      );
    }
  }

  return {
    readFeature,
    readPage,
    readThroughPage,
    verifyThroughApi,
    requirePrerequisite,

    /**
     * Forget the page reading, so the next one opens a fresh page.
     * @returns {void}
     */
    forgetPage() {
      pageRows = null;
      pageError = null;
    },
  };
}

/**
 * Create the gateway for one repository.
 * @param {Object} options - Gateway options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.rest - REST client
 * @param {Object} options.log - Logger
 * @param {() => Promise<Object>} options.getSession - Opens (or reuses) a browser session
 * @param {number} [options.verificationTimeout] - How long to wait for the API to agree
 * @returns {Object} Security gateway
 */
export function createSecurityGateway({
  repo,
  rest,
  log,
  getSession,
  verificationTimeout = VERIFICATION_TIMEOUT_MS,
}) {
  const slug = repoSlug(repo);
  const readers = createSecurityReaders({
    repo,
    rest,
    log,
    getSession,
    verificationTimeout,
  });

  /**
   * Perform the change, through the API when it has an endpoint and accepts it.
   * @param {Object} feature - Feature definition
   * @param {boolean} enabled - Wanted state
   * @returns {Promise<{by: string, reported: string|null}>} What performed it
   */
  async function write(feature, enabled) {
    if (canWriteThroughApi(rest, feature)) {
      const attempt = await writeFeatureThroughApi(rest, {
        repo,
        feature,
        enabled,
      });

      if (attempt.written) {
        return { by: 'api', reported: null };
      }

      log.debug(
        `API refused to ${stateName(enabled)} ${feature.id} on ${slug} (${attempt.reason}); using the browser`
      );
    }

    const session = await getSession();
    const { reported } = await setSecurityFeature(session, {
      repo,
      feature,
      enabled,
      log,
    });

    readers.forgetPage();
    return { by: 'browser', reported };
  }

  return {
    readFeature: readers.readFeature,

    /**
     * Read the state of every feature.
     * @returns {Promise<Array<Object>>} One status per feature
     */
    async readAll() {
      const metadata = await rest.send(repoPath(repo));
      const visibility =
        metadata.body?.visibility ??
        (metadata.body?.private === false ? 'public' : 'unknown');
      const statuses = [];
      for (const feature of SECURITY_FEATURES) {
        let status;
        try {
          status = await readers.readFeature(feature);
        } catch (error) {
          status = {
            id: feature.id,
            label: feature.label,
            state: 'unknown',
            source: 'none',
            reason: error.message,
          };
        }
        const defaultState = securityDefault(feature, visibility);
        statuses.push({
          ...status,
          defaultState,
          visibility,
          differsFromDefault:
            status.state === 'unknown' || defaultState === 'unknown'
              ? null
              : status.state !== defaultState,
        });
      }
      try {
        const rows = await readers.readPage();
        for (const row of Object.values(rows)) {
          if (SECURITY_FEATURES.some((feature) => feature.id === row.id)) {
            continue;
          }
          statuses.push({
            ...row,
            source: 'page',
            visibility,
            defaultState: 'unknown',
            differsFromDefault: null,
          });
        }
      } catch (error) {
        log.debug(`Page inventory incomplete: ${error.message}`);
      }
      return statuses;
    },

    /**
     * Turn one feature on or off, and prove afterwards that it is.
     * @param {Object} options - Operation options
     * @param {Object} options.feature - Feature definition
     * @param {boolean} options.enabled - Wanted state
     * @returns {Promise<{feature: string, state: string, changed: boolean, changedBy: string|null, verifiedBy: string}>} Outcome
     */
    async setFeature({ feature, enabled }) {
      if (enabled && feature.id === 'code-scanning-default-setup') {
        const workflows = await workflowFiles(rest, repo);
        const advanced = workflows
          .flatMap(({ file, source }) =>
            workflowRequirements({
              path: `.github/workflows/${file}`,
              content: source,
            })
          )
          .find((entry) => entry.setting === 'code-scanning-default-setup');
        if (advanced) {
          throw new CliError(
            `Refusing default setup: ${advanced.evidence.file}:${advanced.evidence.line} uses advanced code scanning. Default setup blocks advanced CodeQL uploads. Disable the advanced workflow first.`
          );
        }
      }
      const wanted = stateName(enabled);
      const before = await readers.readFeature(feature);

      if (before.state === wanted) {
        return {
          feature: feature.id,
          state: wanted,
          changed: false,
          changedBy: null,
          verifiedBy: before.source,
        };
      }

      await readers.requirePrerequisite(feature, enabled);

      const performed = await write(feature, enabled);
      const check = await readers.verifyThroughApi(feature, enabled);

      if (check.verified) {
        return {
          feature: feature.id,
          state: wanted,
          changed: true,
          changedBy: performed.by,
          verifiedBy: 'api',
        };
      }

      if (check.checked && !feature.read?.lagging) {
        throw new CliError(
          `"${feature.label}" still reports "${check.state}" for ${slug} after the change was submitted.`,
          EXIT_CODES.VERIFICATION_FAILED
        );
      }

      const onPage =
        performed.reported ??
        (await readers.readThroughPage(feature, true)).state;

      if (onPage !== wanted) {
        throw new CliError(
          `Could not confirm that "${feature.label}" is ${wanted} for ${slug}: the API reports ${check.state === 'unknown' ? 'nothing' : `"${check.state}"`} and the settings page reports ${onPage === 'unknown' ? 'nothing' : `"${onPage}"`}.`,
          EXIT_CODES.VERIFICATION_FAILED
        );
      }

      return {
        feature: feature.id,
        state: wanted,
        changed: true,
        changedBy: performed.by,
        verifiedBy: 'page',
      };
    },
  };
}
