/**
 * The page drivers: enumeration, visibility changes, and deletion.
 *
 * The fixtures in `tests/fixtures/github-pages.js` hold the state a real
 * GitHub would hold, so each test acts through the shipped driver and then
 * asserts on what actually changed — including that a confirmation dialog was
 * really filled in with the phrase the dialog asked for.
 */

import { describe, it, expect } from 'test-anywhere';

import { EXIT_CODES } from '../src/exit-codes.js';
import { createLogger } from '../src/logging.js';
import { listPackageNames } from '../src/browser/package-list.js';
import {
  deletePackage,
  openPackageSettings,
  setPackageVisibility,
} from '../src/browser/package-settings.js';
import { packagesListUrl } from '../src/browser/selectors.js';
import { createFakeSession } from './fixtures/fake-browser.js';
import {
  OWNER,
  PACKAGE_TYPE,
  listingRoutes,
  packagePages,
} from './fixtures/github-pages.js';

const log = createLogger({
  verbose: false,
  stdout: () => {},
  stderr: () => {},
});

/**
 * Run an operation and return the error it produced.
 * @param {() => Promise<any>} operation - Work expected to fail
 * @returns {Promise<Error>} The thrown error
 */
async function failureOf(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error('expected the operation to fail');
}

describe('listPackageNames', () => {
  it('walks the listing pages until one adds nothing new', async () => {
    const session = createFakeSession({
      routes: listingRoutes([['box', 'box-dind'], ['gh-manager']]),
    });

    const names = await listPackageNames(session, {
      owner: OWNER,
      packageType: PACKAGE_TYPE,
      log,
    });

    expect(names).toEqual(['box', 'box-dind', 'gh-manager']);
    // Three pages: two with packages, and the repeat that ends the walk.
    expect(session.visited.length).toBe(3);
    expect(session.visited[0]).toBe(
      packagesListUrl({ owner: OWNER, packageType: PACKAGE_TYPE, page: 1 })
    );
  });

  it('stops at the page limit and never loops forever', async () => {
    const routes = {};

    for (let page = 1; page <= 10; page += 1) {
      routes[
        packagesListUrl({ owner: OWNER, packageType: PACKAGE_TYPE, page })
      ] =
        `<!doctype html><html><head><title>Packages</title><meta name="user-login" content="konard"></head><body><a href="/orgs/link-foundation/packages/container/package/box-${page}">box</a></body></html>`;
    }

    const session = createFakeSession({ routes });
    const names = await listPackageNames(session, {
      owner: OWNER,
      packageType: PACKAGE_TYPE,
      log,
      maxPages: 3,
    });

    expect(names).toEqual(['box-1', 'box-2', 'box-3']);
  });

  it('refuses to enumerate with a signed-out profile', async () => {
    const session = createFakeSession({
      routes: {
        [packagesListUrl({ owner: OWNER, packageType: PACKAGE_TYPE, page: 1 })]:
          '<!doctype html><html><head><title>Packages</title></head><body></body></html>',
      },
    });

    const error = await failureOf(() =>
      listPackageNames(session, {
        owner: OWNER,
        packageType: PACKAGE_TYPE,
        log,
      })
    );

    expect(error.exitCode).toBe(EXIT_CODES.AUTH);
    expect(error.message).toContain('gh-manager auth login');
  });
});

describe('openPackageSettings', () => {
  it('opens the direct settings URL when it exists', async () => {
    const { routes, settingsUrl, coordinates } = packagePages({
      packageName: 'box',
    });
    const session = createFakeSession({ routes });

    expect(await openPackageSettings(session, { ...coordinates, log })).toBe(
      settingsUrl
    );
    expect(session.visited).toEqual([settingsUrl]);
  });

  it('follows the settings link when the direct URLs miss', async () => {
    const { routes, settingsUrl, coordinates } = packagePages({
      packageName: 'box',
      settingsVia: 'link',
    });
    const session = createFakeSession({ routes });

    expect(await openPackageSettings(session, { ...coordinates, log })).toBe(
      settingsUrl
    );
    // Both direct candidates, then the package page, then the link.
    expect(session.visited.length).toBe(4);
  });

  it('fails with artifacts when the link does not lead to the settings page', async () => {
    const { routes, coordinates } = packagePages({
      packageName: 'box',
      settingsVia: 'nowhere',
    });
    const session = createFakeSession({ routes });

    const error = await failureOf(() =>
      openPackageSettings(session, { ...coordinates, log })
    );

    expect(error.message).toContain('Could not reach the settings page');
    expect(error.message).toContain('may lack admin rights');
    expect(session.captures.length).toBe(1);
  });

  it('reports a package that does not exist', async () => {
    const { coordinates } = packagePages({ packageName: 'box' });
    const session = createFakeSession({ routes: {} });

    const error = await failureOf(() =>
      openPackageSettings(session, { ...coordinates, log })
    );

    expect(error.message).toContain('does not exist');
    expect(error.exitCode).toBe(EXIT_CODES.FAILURE);
  });
});

describe('setPackageVisibility', () => {
  it('selects the visibility, types the phrase the dialog asks for, and submits', async () => {
    const { routes, state, coordinates } = packagePages({
      packageName: 'box',
      visibility: 'private',
    });
    const session = createFakeSession({ routes });

    const result = await setPackageVisibility(session, {
      ...coordinates,
      visibility: 'public',
      log,
    });

    expect(state.visibility).toBe('public');
    expect(state.submissions).toEqual([
      { dialog: 'visibility-dialog', typed: 'box' },
    ]);
    expect(result.reported).toBe('public');
  });

  it('fails with artifacts when the dialog offers no such visibility', async () => {
    const { routes, coordinates } = packagePages({ packageName: 'box' });
    const session = createFakeSession({ routes });

    const error = await failureOf(() =>
      setPackageVisibility(session, {
        ...coordinates,
        visibility: 'secret',
        log,
      })
    );

    expect(error.message).toContain('offers no "secret" option');
    expect(error.message).toContain('/logs/');
    expect(session.captures.length).toBe(1);
  });
});

describe('deletePackage', () => {
  it('confirms the deletion with the phrase the dialog states', async () => {
    const { routes, state, coordinates } = packagePages({
      packageName: 'box-dind',
    });
    const session = createFakeSession({ routes });

    expect(await deletePackage(session, { ...coordinates, log })).toEqual({
      submitted: true,
    });
    expect(state.deleted).toBe(true);
    expect(state.submissions).toEqual([
      { dialog: 'delete-dialog', typed: 'box-dind' },
    ]);
  });
});
