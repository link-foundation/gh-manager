/**
 * The read half of the tool: token discovery and the REST client.
 */

import { describe, it, expect } from 'test-anywhere';

import {
  GitHubApiError,
  createRestClient,
  ownerPath,
} from '../src/github/rest.js';
import {
  TOKEN_ENVIRONMENT_VARIABLES,
  resolveToken,
} from '../src/github/token.js';

/**
 * Build a fetch implementation that answers from a table of paths.
 * @param {Object} routes - Map of path to `{status, body}` or an array of them
 * @returns {Function} fetch replacement recording the calls it received
 */
function fakeFetch(routes) {
  const calls = [];

  /**
   * @param {string} url - Requested URL
   * @param {Object} options - Request options
   * @returns {Promise<Object>} Response-like object
   */
  async function impl(url, options) {
    calls.push({ url, headers: options.headers });
    const path = url.replace('https://api.github.test', '');
    const route = routes[path];

    if (!route) {
      return { ok: false, status: 404, json: async () => ({}) };
    }

    const answer = Array.isArray(route) ? route.shift() : route;

    return {
      ok: answer.status === undefined || answer.status < 400,
      status: answer.status ?? 200,
      json: async () => answer.body,
    };
  }

  impl.calls = calls;
  return impl;
}

/**
 * Create a client bound to the fake API host.
 * @param {Object} routes - Route table for fakeFetch
 * @param {Object} [options] - Extra client options
 * @returns {Object} REST client with the fetch implementation attached
 */
function clientFor(routes, options = {}) {
  const fetchImpl = fakeFetch(routes);
  const client = createRestClient({
    token: 'test-token',
    fetch: fetchImpl,
    baseUrl: 'https://api.github.test',
    ...options,
  });
  client.fetchImpl = fetchImpl;
  return client;
}

const owner = { scope: 'orgs', name: 'link-foundation' };

describe('resolveToken', () => {
  it('prefers --token over everything else', () => {
    expect(
      resolveToken({
        token: 'flag',
        env: { GH_TOKEN: 'env' },
        readCliToken: () => 'cli',
      })
    ).toEqual({ token: 'flag', source: '--token' });
  });

  it('checks the environment variables in order', () => {
    expect(TOKEN_ENVIRONMENT_VARIABLES).toEqual([
      'GH_MANAGER_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ]);

    expect(
      resolveToken({
        env: { GH_TOKEN: 'second', GITHUB_TOKEN: 'third' },
        readCliToken: () => 'cli',
      })
    ).toEqual({ token: 'second', source: 'GH_TOKEN' });
  });

  it('falls back to the token the GitHub CLI already has', () => {
    expect(resolveToken({ env: {}, readCliToken: () => 'cli' })).toEqual({
      token: 'cli',
      source: 'gh auth token',
    });
  });

  it('reports no token and never invents one', () => {
    expect(resolveToken({ env: {}, readCliToken: () => null })).toEqual({
      token: null,
      source: null,
    });
  });
});

describe('ownerPath', () => {
  it('uses the scope GitHub serves the owner under', () => {
    expect(ownerPath(owner)).toBe('/orgs/link-foundation');
    expect(ownerPath({ scope: 'users', name: 'konard' })).toBe('/users/konard');
  });
});

describe('createRestClient', () => {
  it('sends the documented API headers and the bearer token', async () => {
    const client = clientFor({
      '/orgs/link-foundation/packages/container/box': { body: { name: 'box' } },
    });

    await client.getPackage({
      owner,
      packageType: 'container',
      packageName: 'box',
    });

    const [call] = client.fetchImpl.calls;

    expect(call.headers.accept).toBe('application/vnd.github+json');
    expect(call.headers['x-github-api-version']).toBe('2022-11-28');
    expect(call.headers.authorization).toBe('Bearer test-token');
  });

  it('omits the authorization header without a token', async () => {
    const client = clientFor(
      { '/orgs/link-foundation/packages/container/box': { body: {} } },
      { token: null }
    );

    expect(client.hasToken).toBe(false);

    await client.getPackage({
      owner,
      packageType: 'container',
      packageName: 'box',
    });

    expect(client.fetchImpl.calls[0].headers.authorization).toBe(undefined);
  });

  it('returns null for a package that does not exist', async () => {
    const client = clientFor({});

    expect(
      await client.getPackage({
        owner,
        packageType: 'container',
        packageName: 'gone',
      })
    ).toBe(null);
  });

  it('raises a GitHubApiError for other failures', async () => {
    const client = clientFor({
      '/orgs/link-foundation/packages/container/box': { status: 403, body: {} },
    });

    try {
      await client.getPackage({
        owner,
        packageType: 'container',
        packageName: 'box',
      });
    } catch (error) {
      expect(error instanceof GitHubApiError).toBe(true);
      expect(error.status).toBe(403);
      expect(error.path).toBe('/orgs/link-foundation/packages/container/box');
      return;
    }

    throw new Error('expected a 403 to be raised');
  });

  it('follows pagination when listing packages', async () => {
    const page = (names) => ({
      body: names.map((name) => ({ name, visibility: 'private' })),
    });
    const full = Array.from({ length: 100 }, (unused, index) => `box-${index}`);
    const client = clientFor({
      '/orgs/link-foundation/packages?package_type=container&per_page=100&page=1':
        page(full),
      '/orgs/link-foundation/packages?package_type=container&per_page=100&page=2':
        page(['last']),
    });

    const packages = await client.listPackages({
      owner,
      packageType: 'container',
    });

    expect(packages.length).toBe(101);
    expect(packages[100].name).toBe('last');
  });

  it('stops listing on the first empty page', async () => {
    const client = clientFor({
      '/orgs/link-foundation/packages?package_type=container&per_page=100&page=1':
        { body: [] },
    });

    expect(
      await client.listPackages({ owner, packageType: 'container' })
    ).toEqual([]);
    expect(client.fetchImpl.calls.length).toBe(1);
  });
});
