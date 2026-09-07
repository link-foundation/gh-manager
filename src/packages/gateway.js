/**
 * The hybrid strategy: read through the API, write through the browser, and
 * verify through the API again.
 *
 * Two facts drive this split. GitHub exposes no endpoint for changing a
 * package's visibility or its permissions, so those have to happen in a page.
 * And `GET /{scope}/{owner}/packages?package_type=container` answers with an
 * empty array for tokens without the package scopes, which is why an empty
 * REST listing falls back to enumerating the pages the browser can see instead
 * of reporting "no packages found".
 */

import { EXIT_CODES, CliError } from '../exit-codes.js';
import { gotoUrl } from '../browser/actions.js';
import { readPageState } from '../browser/dom.js';
import { listPackageNames } from '../browser/package-list.js';
import {
  deletePackage as deletePackageInBrowser,
  setPackageVisibility,
} from '../browser/package-settings.js';
import { packageUrl } from '../browser/selectors.js';

/** How long to keep re-reading the API before calling a change unverified. */
const VERIFICATION_TIMEOUT_MS = 15000;

/** Delay between verification reads. */
const VERIFICATION_INTERVAL_MS = 1000;

/**
 * Sleep, used only between API verification reads.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>} Resolves after the delay
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Build the reads the gateway performs: the API lookups, the browser
 * enumeration, and the verification loop that decides whether a change landed.
 * @param {Object} options - Reader options
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {Object} options.rest - REST client
 * @param {Object} options.log - Logger
 * @param {() => Promise<Object>} options.getSession - Opens (or reuses) a browser session
 * @param {number} options.verificationTimeout - How long to wait for the API to agree
 * @param {(packageName: string) => Object} options.coordinates - Builds API coordinates
 * @returns {Object} Reading helpers
 */
function createPackageReaders({
  owner,
  packageType,
  rest,
  log,
  getSession,
  verificationTimeout,
  coordinates,
}) {
  /**
   * Read one package through the API.
   *
   * The outcome separates the three answers a read can give, because a delete
   * is only confirmed by the first of them:
   *
   * - `absent`: GitHub answered 404, so the package really is not there.
   * - `present`: the payload came back.
   * - `unknown`: no token, or the read itself failed (403, 5xx, network).
   *
   * Collapsing `unknown` into `absent` is what would let a failed read look
   * like a successful deletion, so the two are never merged.
   * @param {string} packageName - Package name
   * @returns {Promise<{state: 'present'|'absent'|'unknown', payload: Object|null}>} Read outcome
   */
  async function readPackageOutcome(packageName) {
    if (!rest.hasToken) {
      return { state: 'unknown', payload: null };
    }

    try {
      const payload = await rest.getPackage(coordinates(packageName));
      return payload === null
        ? { state: 'absent', payload: null }
        : { state: 'present', payload };
    } catch (error) {
      log.debug(`API read of ${packageName} failed: ${error.message}`);
      return { state: 'unknown', payload: null };
    }
  }

  /**
   * Read one package through the API, keeping only the payload.
   * @param {string} packageName - Package name
   * @returns {Promise<Object|null>} Package payload, or null when unavailable
   */
  async function readPackage(packageName) {
    const { payload } = await readPackageOutcome(packageName);
    return payload;
  }

  /**
   * List packages through the API, tolerating a token without package scopes.
   * @returns {Promise<Array<Object>>} Packages, possibly empty
   */
  async function listThroughApi() {
    if (!rest.hasToken) {
      return [];
    }

    try {
      return await rest.listPackages({ owner, packageType });
    } catch (error) {
      log.debug(`API listing failed: ${error.message}`);
      return [];
    }
  }

  /**
   * List packages through the browser.
   * @returns {Promise<Array<Object>>} Packages with the visibility the API knows
   */
  async function listThroughBrowser() {
    const session = await getSession();
    const names = await listPackageNames(session, {
      owner,
      packageType,
      log,
    });

    const packages = [];

    for (const name of names) {
      const payload = await readPackage(name);
      packages.push({
        name,
        visibility: payload?.visibility ?? null,
        source: 'browser',
      });
    }

    return packages;
  }

  /**
   * Re-read a package until the API agrees with what was just done.
   *
   * `checked` is false when the API cannot see the package at all — no token,
   * or a token without the package scopes. That case is not a verification
   * failure, it is an absence of evidence, and the caller falls back to reading
   * the page, and never pretends either way.
   * `accept` receives the full read outcome, so a caller can require an
   * explicit 404 rather than treating any unreadable package as gone.
   *
   * A read that never becomes conclusive — every attempt returned `unknown` —
   * is reported as unchecked rather than as a failure, because a token that
   * cannot see the package is an absence of evidence, not evidence of absence.
   * @param {Object} options - Verification options
   * @param {string} options.packageName - Package name
   * @param {boolean} options.apiCanSee - Whether the API saw the package before the change
   * @param {(outcome: {state: string, payload: Object|null}) => boolean} options.accept - Success condition
   * @returns {Promise<{checked: boolean, verified: boolean, payload: Object|null}>} Result
   */
  async function verifyThroughApi({ packageName, apiCanSee, accept }) {
    if (!rest.hasToken || !apiCanSee) {
      return { checked: false, verified: false, payload: null };
    }

    const deadline = Date.now() + verificationTimeout;
    let outcome = await readPackageOutcome(packageName);
    let sawConclusiveRead = outcome.state !== 'unknown';

    while (!accept(outcome)) {
      if (Date.now() >= deadline) {
        return {
          checked: sawConclusiveRead,
          verified: false,
          payload: outcome.payload,
        };
      }

      await delay(VERIFICATION_INTERVAL_MS);
      outcome = await readPackageOutcome(packageName);
      sawConclusiveRead = sawConclusiveRead || outcome.state !== 'unknown';
    }

    return { checked: true, verified: true, payload: outcome.payload };
  }

  /**
   * Check in the browser whether a package page is gone.
   * @param {string} packageName - Package name
   * @returns {Promise<boolean>} True when GitHub answers "page not found"
   */
  async function isGoneInBrowser(packageName) {
    const session = await getSession();
    await gotoUrl(session, packageUrl(coordinates(packageName)));
    const state = await readPageState(session.commander);
    return state.notFound;
  }

  return {
    readPackage,
    listThroughApi,
    listThroughBrowser,
    verifyThroughApi,
    isGoneInBrowser,
  };
}

/**
 * Create the gateway used by every package command.
 * @param {Object} options - Gateway options
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {Object} options.rest - REST client
 * @param {Object} options.log - Logger
 * @param {() => Promise<Object>} options.getSession - Opens (or reuses) a browser session
 * @param {number} [options.verificationTimeout] - How long to wait for the API to agree
 * @returns {Object} Gateway
 */
export function createPackageGateway({
  owner,
  packageType,
  rest,
  log,
  getSession,
  verificationTimeout = VERIFICATION_TIMEOUT_MS,
}) {
  const coordinates = (packageName) => ({ owner, packageType, packageName });

  const {
    readPackage,
    listThroughApi,
    listThroughBrowser,
    verifyThroughApi,
    isGoneInBrowser,
  } = createPackageReaders({
    owner,
    packageType,
    rest,
    log,
    getSession,
    verificationTimeout,
    coordinates,
  });

  return {
    /**
     * List the owner's packages, falling back to the browser when the API
     * returns nothing.
     * @returns {Promise<{packages: Array<Object>, source: string}>} Listing
     */
    async listPackages() {
      const fromApi = await listThroughApi();

      if (fromApi.length > 0) {
        return {
          packages: fromApi.map((entry) => ({
            name: entry.name,
            visibility: entry.visibility ?? null,
            source: 'api',
          })),
          source: 'api',
        };
      }

      log.debug(
        rest.hasToken
          ? 'the API returned no packages; enumerating them in the browser'
          : 'no API token available; enumerating packages in the browser'
      );

      return { packages: await listThroughBrowser(), source: 'browser' };
    },

    /**
     * List package names only, which is what pattern expansion needs.
     * @returns {Promise<string[]>} Package names
     */
    async listNames() {
      const { packages } = await this.listPackages();
      return packages.map((entry) => entry.name);
    },

    /**
     * Read the visibility the API reports for a package.
     * @param {string} packageName - Package name
     * @returns {Promise<string|null>} Visibility, or null when unknown
     */
    async readVisibility(packageName) {
      const payload = await readPackage(packageName);
      return payload?.visibility ?? null;
    },

    /**
     * Change a package's visibility and confirm the change through the API.
     * @param {Object} options - Operation options
     * @param {string} options.packageName - Package name
     * @param {string} options.visibility - Target visibility
     * @returns {Promise<{packageName: string, visibility: string, changed: boolean, verified: boolean, reported: string|null}>} Outcome
     */
    async setVisibility({ packageName, visibility }) {
      const before = await readPackage(packageName);

      if (before?.visibility === visibility) {
        log.debug(`${packageName} is already ${visibility}`);
        return {
          packageName,
          visibility,
          changed: false,
          verified: true,
          verifiedBy: 'api',
          reported: visibility,
        };
      }

      const session = await getSession();
      const { reported } = await setPackageVisibility(session, {
        ...coordinates(packageName),
        visibility,
        log,
      });

      const check = await verifyThroughApi({
        packageName,
        apiCanSee: before !== null,
        accept: ({ payload }) => payload?.visibility === visibility,
      });

      if (check.checked && !check.verified) {
        throw new CliError(
          `${packageName} still reports "${check.payload?.visibility ?? 'unknown'}" after the change was submitted`,
          EXIT_CODES.VERIFICATION_FAILED
        );
      }

      if (!check.checked && reported !== visibility) {
        throw new CliError(
          `Could not confirm that ${packageName} is ${visibility}: the API cannot see this package and the settings page reports ${reported ? `"${reported}"` : 'nothing'}`,
          EXIT_CODES.VERIFICATION_FAILED
        );
      }

      return {
        packageName,
        visibility,
        changed: true,
        verified: true,
        verifiedBy: check.verified ? 'api' : 'page',
        reported: reported ?? null,
      };
    },

    /**
     * Delete a package and confirm through the API that it is gone.
     * @param {Object} options - Operation options
     * @param {string} options.packageName - Package name
     * @returns {Promise<{packageName: string, deleted: boolean, verified: boolean}>} Outcome
     */
    async deletePackage({ packageName }) {
      const before = await readPackage(packageName);
      const session = await getSession();

      await deletePackageInBrowser(session, {
        ...coordinates(packageName),
        log,
      });

      const check = await verifyThroughApi({
        packageName,
        apiCanSee: before !== null,
        accept: ({ state }) => state === 'absent',
      });

      const verifiedBy = check.verified
        ? 'api'
        : (await isGoneInBrowser(packageName))
          ? 'page'
          : null;

      if (!verifiedBy) {
        throw new CliError(
          `${packageName} still exists after the delete was submitted`,
          EXIT_CODES.VERIFICATION_FAILED
        );
      }

      return { packageName, deleted: true, verified: true, verifiedBy };
    },
  };
}
