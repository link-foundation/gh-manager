/**
 * A GitHub REST API made of a route table.
 *
 * The client under test is the real one: only `fetch` is replaced, so the
 * headers, the pagination, the method, and the body are all exercised. Routes
 * are keyed by path, or by `"<METHOD> <path>"` when a test needs the same path
 * to answer differently per method, which is what the security toggles do.
 */

import { createRestClient } from '../../src/github/rest.js';

/** Host the fake API answers for. */
export const API_BASE_URL = 'https://api.github.test';

/**
 * Build a fetch implementation that answers from a table of routes.
 * @param {Object} routes - Map of `path` or `"METHOD path"` to `{status, body}`,
 *   to an array of them consumed in order, or to a function of the request
 * @returns {Function} fetch replacement recording the calls it received
 */
export function fakeFetch(routes) {
  const calls = [];

  /**
   * @param {string} url - Requested URL
   * @param {Object} [options] - Request options
   * @returns {Promise<Object>} Response-like object
   */
  async function impl(url, options = {}) {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const path = url.replace(API_BASE_URL, '');
    calls.push({ url, path, method, headers: options.headers, body });

    const route = routes[`${method} ${path}`] ?? routes[path];

    if (!route) {
      return { ok: false, status: 404, json: async () => ({}) };
    }

    const picked = Array.isArray(route) ? route.shift() : route;
    const answer =
      typeof picked === 'function' ? picked({ method, body }) : picked;

    return {
      ok: answer.status === undefined || answer.status < 400,
      status: answer.status ?? 200,
      json: async () => {
        if (answer.body === undefined) {
          throw new SyntaxError('Unexpected end of JSON input');
        }

        return answer.body;
      },
    };
  }

  impl.calls = calls;
  return impl;
}

/**
 * Create a REST client bound to the fake API host.
 * @param {Object} routes - Route table for fakeFetch
 * @param {Object} [options] - Extra client options
 * @returns {Object} REST client with the fetch implementation attached
 */
export function restClientFor(routes, options = {}) {
  const fetchImpl = fakeFetch(routes);
  const client = createRestClient({
    token: 'test-token',
    fetch: fetchImpl,
    baseUrl: API_BASE_URL,
    ...options,
  });
  client.fetchImpl = fetchImpl;
  return client;
}
