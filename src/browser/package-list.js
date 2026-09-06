/**
 * Package enumeration through the browser.
 *
 * `GET /orgs/{org}/packages?package_type=container` returns an empty array for
 * tokens that lack the right package scopes, even when the organization owns
 * dozens of packages. Reporting "no packages found" in that situation would be
 * a lie, so the same list is read from the pages the browser can see.
 */

import { assertSignedIn, gotoUrl } from './actions.js';
import { collectPackageNames, readPageState } from './dom.js';
import { packagesListUrl } from './selectors.js';

/** Upper bound on listing pages, so a pagination change cannot loop forever. */
const MAX_PAGES = 50;

/**
 * List the packages of an owner by walking the listing pages.
 * @param {Object} session - Browser session
 * @param {Object} options - Listing options
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {Object} options.log - Logger
 * @param {number} [options.maxPages] - Safety bound on pages to visit
 * @returns {Promise<string[]>} Package names, in listing order
 */
export async function listPackageNames(
  session,
  { owner, packageType, log, maxPages = MAX_PAGES }
) {
  const names = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page += 1) {
    const url = packagesListUrl({ owner, packageType, page });
    await gotoUrl(session, url);
    assertSignedIn(await readPageState(session.commander));

    const batch = await collectPackageNames(session.commander, { packageType });
    const fresh = batch.filter((name) => !seen.has(name));

    log.debug(
      `listing page ${page}: ${batch.length} link(s), ${fresh.length} new`
    );

    // GitHub answers an out-of-range page with the last one it has, so the
    // walk stops as soon as a page contributes no new name.
    if (fresh.length === 0) {
      break;
    }

    for (const name of fresh) {
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}
