/**
 * The hybrid strategy: read through the API, write through the browser, verify
 * through the API again.
 *
 * The two behaviours worth guarding are that an empty REST listing is never
 * reported as "no packages", and that a change is only reported as done when
 * something confirmed it — the API if it can see the package, the page itself
 * otherwise.
 */

import { describe, it, expect } from 'test-anywhere';

import { EXIT_CODES } from '../src/exit-codes.js';
import { createLogger } from '../src/logging.js';
import { createPackageGateway } from '../src/packages/gateway.js';
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
 * Build a gateway over a fake API and a fake browser.
 * @param {Object} options - Gateway options
 * @param {Object} options.rest - REST stub
 * @param {Object} [options.routes] - Routes for the fake browser
 * @param {number} [options.verificationTimeout] - Verification budget
 * @returns {Object} Gateway plus the session it opened, once it opens one
 */
function gatewayFor({ rest, routes = {}, verificationTimeout = 0 }) {
  const opened = [];
  const gateway = createPackageGateway({
    owner: OWNER,
    packageType: PACKAGE_TYPE,
    rest,
    log,
    verificationTimeout,
    getSession: async () => {
      if (opened.length === 0) {
        opened.push(createFakeSession({ routes }));
      }

      return opened[0];
    },
  });

  return { gateway, opened };
}

/**
 * A REST stub that answers from a mutable store.
 * @param {Object} store - Package name to payload, or null when deleted
 * @param {Object} [options] - Stub options
 * @param {boolean} [options.hasToken] - Whether a token is configured
 * @returns {Object} REST client stand-in
 */
function restStub(store, { hasToken = true } = {}) {
  return {
    hasToken,
    /**
     * @returns {Promise<Array<Object>>} Packages the API can see
     */
    async listPackages() {
      return Object.values(store).filter(Boolean);
    },
    /**
     * @param {Object} options - Coordinates
     * @param {string} options.packageName - Package name
     * @returns {Promise<Object|null>} Package payload
     */
    async getPackage({ packageName }) {
      return store[packageName] ?? null;
    },
  };
}

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

describe('listPackages', () => {
  it('uses the API when it answers with packages', async () => {
    const { gateway, opened } = gatewayFor({
      rest: restStub({ box: { name: 'box', visibility: 'private' } }),
    });

    expect(await gateway.listPackages()).toEqual({
      packages: [{ name: 'box', visibility: 'private', source: 'api' }],
      source: 'api',
    });
    expect(opened.length).toBe(0);
  });

  it('enumerates in the browser when the API answers with nothing', async () => {
    const { gateway } = gatewayFor({
      rest: restStub({}),
      routes: listingRoutes([['box', 'box-dind']]),
    });

    const listing = await gateway.listPackages();

    expect(listing.source).toBe('browser');
    expect(listing.packages.map((entry) => entry.name)).toEqual([
      'box',
      'box-dind',
    ]);
  });

  it('enumerates in the browser when there is no token at all', async () => {
    const { gateway } = gatewayFor({
      rest: restStub({}, { hasToken: false }),
      routes: listingRoutes([['box']]),
    });

    expect(await gateway.listNames()).toEqual(['box']);
  });

  it('reports the visibility the API knows for browser-enumerated packages', async () => {
    const { gateway } = gatewayFor({
      rest: {
        hasToken: true,
        /**
         * @returns {Promise<Array>} An empty listing, as GitHub answers for a
         *   token without the package scopes
         */
        async listPackages() {
          return [];
        },
        /**
         * @param {Object} options - Coordinates
         * @param {string} options.packageName - Package name
         * @returns {Promise<Object>} Package payload
         */
        async getPackage({ packageName }) {
          return { name: packageName, visibility: 'public' };
        },
      },
      routes: listingRoutes([['box']]),
    });

    expect((await gateway.listPackages()).packages).toEqual([
      { name: 'box', visibility: 'public', source: 'browser' },
    ]);
  });
});

describe('setVisibility', () => {
  it('does nothing when the package already has the requested visibility', async () => {
    const { gateway, opened } = gatewayFor({
      rest: restStub({ box: { name: 'box', visibility: 'public' } }),
    });

    expect(
      await gateway.setVisibility({ packageName: 'box', visibility: 'public' })
    ).toEqual({
      packageName: 'box',
      visibility: 'public',
      changed: false,
      verified: true,
      verifiedBy: 'api',
      reported: 'public',
    });
    expect(opened.length).toBe(0);
  });

  it('changes the visibility in the browser and confirms it through the API', async () => {
    const { routes, state } = packagePages({
      packageName: 'box',
      visibility: 'private',
    });
    const { gateway } = gatewayFor({
      rest: {
        hasToken: true,
        /**
         * @returns {Promise<Array>} Unused by this test
         */
        async listPackages() {
          return [];
        },
        /**
         * @returns {Promise<Object>} What GitHub reports after the change
         */
        async getPackage() {
          return { name: 'box', visibility: state.visibility };
        },
      },
      routes,
    });

    const result = await gateway.setVisibility({
      packageName: 'box',
      visibility: 'public',
    });

    expect(state.visibility).toBe('public');
    expect(result).toEqual({
      packageName: 'box',
      visibility: 'public',
      changed: true,
      verified: true,
      verifiedBy: 'api',
      reported: 'public',
    });
  });

  it('refuses to report success when the API keeps disagreeing', async () => {
    const { routes } = packagePages({
      packageName: 'box',
      visibility: 'private',
    });
    const { gateway } = gatewayFor({
      rest: restStub({ box: { name: 'box', visibility: 'private' } }),
      routes,
    });

    const error = await failureOf(() =>
      gateway.setVisibility({ packageName: 'box', visibility: 'public' })
    );

    expect(error.message).toBe(
      'box still reports "private" after the change was submitted'
    );
    expect(error.exitCode).toBe(EXIT_CODES.VERIFICATION_FAILED);
  });

  it('falls back to the page when the API cannot see the package', async () => {
    const { routes } = packagePages({
      packageName: 'box',
      visibility: 'private',
    });
    const { gateway } = gatewayFor({ rest: restStub({}), routes });

    const result = await gateway.setVisibility({
      packageName: 'box',
      visibility: 'public',
    });

    expect(result.verifiedBy).toBe('page');
    expect(result.reported).toBe('public');
  });

  it('fails when neither the API nor the page can confirm the change', async () => {
    const { routes } = packagePages({
      packageName: 'box',
      visibility: 'private',
    });
    // The settings page stops stating a visibility, so nothing confirms it.
    routes[Object.keys(routes)[1]] = {
      html: '<!doctype html><html><head><title>box</title><meta name="user-login" content="konard"></head><body><button id="change-visibility">Change visibility</button><div id="dialogs"><div role="dialog"><label><input type="radio" name="visibility" value="public"> public</label><button type="submit">change package visibility</button></div></div></body></html>',
    };

    const { gateway } = gatewayFor({ rest: restStub({}), routes });

    const error = await failureOf(() =>
      gateway.setVisibility({ packageName: 'box', visibility: 'public' })
    );

    expect(error.message).toContain('Could not confirm that box is public');
    expect(error.exitCode).toBe(EXIT_CODES.VERIFICATION_FAILED);
  });
});

describe('deletePackage', () => {
  it('confirms through the API that the package is gone', async () => {
    const { routes, state } = packagePages({ packageName: 'box' });
    const store = { box: { name: 'box', visibility: 'private' } };
    const { gateway } = gatewayFor({
      rest: {
        hasToken: true,
        /**
         * @returns {Promise<Array>} Unused by this test
         */
        async listPackages() {
          return [];
        },
        /**
         * @returns {Promise<Object|null>} Null for a deleted package
         */
        async getPackage() {
          return state.deleted ? null : store.box;
        },
      },
      routes,
    });

    expect(await gateway.deletePackage({ packageName: 'box' })).toEqual({
      packageName: 'box',
      deleted: true,
      verified: true,
      verifiedBy: 'api',
    });
  });

  it('confirms through the page when the API cannot see the package', async () => {
    const { routes, state } = packagePages({ packageName: 'box' });
    const { gateway } = gatewayFor({ rest: restStub({}), routes });

    const result = await gateway.deletePackage({ packageName: 'box' });

    expect(state.deleted).toBe(true);
    expect(result.verifiedBy).toBe('page');
  });

  it('refuses to report a deletion that did not happen', async () => {
    // GitHub asks for a phrase it then does not accept, so the dialog is
    // submitted and the package survives: exactly the case where reporting
    // success would be a lie.
    const { routes, state } = packagePages({
      packageName: 'box',
      dialogPhrase: 'link-foundation/box',
    });
    const { gateway } = gatewayFor({
      rest: restStub({ box: { name: 'box', visibility: 'private' } }),
      routes,
    });

    const error = await failureOf(() =>
      gateway.deletePackage({ packageName: 'box' })
    );

    expect(state.deleted).toBe(false);
    expect(state.submissions).toEqual([
      { dialog: 'delete-dialog', typed: 'link-foundation/box' },
    ]);
    expect(error.message).toBe(
      'box still exists after the delete was submitted'
    );
    expect(error.exitCode).toBe(EXIT_CODES.VERIFICATION_FAILED);
  });
});
