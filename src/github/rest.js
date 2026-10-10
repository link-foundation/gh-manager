/**
 * Minimal GitHub REST client.
 *
 * Reading state through the API is faster and far more reliable than scraping
 * it, so every read goes through here first. Writes stay in the browser
 * wherever GitHub exposes no endpoint for them — package visibility, package
 * deletion, the dependency graph toggle — and go through `send` where an
 * endpoint does exist, because an API write is the more precise instrument.
 */

import { URL } from 'node:url';

const API_BASE_URL = 'https://api.github.com';
const PER_PAGE = 100;

/**
 * Error raised for a non-successful GitHub API response.
 */
export class GitHubApiError extends Error {
  /**
   * @param {string} message - Failure description
   * @param {Object} details - Response details
   * @param {number} details.status - HTTP status code
   * @param {string} details.path - Requested API path
   */
  constructor(message, { status, path }) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Build the REST path prefix for a package owner.
 * @param {{scope: string, name: string}} owner - Owner descriptor
 * @returns {string} Path prefix such as `/orgs/link-foundation`
 */
export function ownerPath(owner) {
  return `/${owner.scope}/${encodeURIComponent(owner.name)}`;
}

/**
 * Build the REST path prefix for a repository.
 * @param {{owner: string, name: string}} repo - Repository descriptor
 * @returns {string} Path prefix such as `/repos/link-foundation/gh-manager`
 */
export function repoPath(repo) {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/**
 * Read the body of a response, tolerating the empty ones GitHub returns.
 *
 * Several of the security endpoints answer `204 No Content` for "yes" and
 * `404` for "no", so a client that insists on parsing JSON cannot talk to
 * them at all.
 * @param {Object} response - fetch response
 * @returns {Promise<any>} Parsed body, or null when there is none
 */
async function readBody(response) {
  if (response.status === 204 || response.status === 205) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Create a REST client bound to a token.
 * @param {Object} [options] - Client options
 * @param {string|null} [options.token] - Bearer token, or null for anonymous
 * @param {Function} [options.fetch] - fetch implementation
 * @param {string} [options.baseUrl] - API base URL
 * @returns {Object} REST client
 */
export function createRestClient({
  token = null,
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = API_BASE_URL,
} = {}) {
  /**
   * Perform one API request and report its status without throwing.
   *
   * The status is the answer for the endpoints that carry their meaning in it
   * (`204` enabled, `404` disabled), so it is never swallowed here.
   * @param {string} apiPath - Path beginning with a slash
   * @param {Object} [options] - Request options
   * @param {string} [options.method] - HTTP method
   * @param {any} [options.body] - JSON body to send
   * @returns {Promise<{status: number, ok: boolean, body: any}>} Response
   */
  async function send(apiPath, { method = 'GET', body = null } = {}) {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'gh-manager',
    };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    if (body !== null) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetchImpl(`${baseUrl}${apiPath}`, {
      method,
      headers,
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });

    return {
      status: response.status,
      ok: Boolean(response.ok),
      body: await readBody(response),
    };
  }

  /**
   * Perform one API request, raising for anything but success.
   * @param {string} apiPath - Path beginning with a slash
   * @param {Object} [options] - Request options
   * @param {boolean} [options.allowNotFound] - Return null for a 404
   * @returns {Promise<any>} Parsed JSON body, or null for a tolerated 404
   */
  async function request(apiPath, { allowNotFound = false, ...options } = {}) {
    const response = await send(apiPath, options);

    if (response.status === 404 && allowNotFound) {
      return null;
    }

    if (!response.ok) {
      throw new GitHubApiError(`GitHub API ${response.status} for ${apiPath}`, {
        status: response.status,
        path: apiPath,
      });
    }

    return response.body;
  }

  return {
    hasToken: Boolean(token),
    request,
    send,
    async text(apiPath) {
      const headers = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'gh-manager',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      let response = await fetchImpl(`${baseUrl}${apiPath}`, {
        headers,
        redirect: 'manual',
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        let url;
        try {
          url = new URL(location, baseUrl);
        } catch {
          // URL parse errors can carry signed URLs in their input field.
        }
        if (
          !location ||
          !url ||
          url.protocol !== 'https:' ||
          url.username ||
          url.password
        ) {
          throw new GitHubApiError(
            'GitHub returned an invalid log download redirect.',
            { status: response.status, path: apiPath }
          );
        }
        // Signed download URLs authorize themselves; never forward the API token.
        response = await fetchImpl(url.href, { redirect: 'error' });
      }
      if (!response.ok) {
        throw new GitHubApiError(`GitHub log download ${response.status}`, {
          status: response.status,
          path: apiPath,
        });
      }
      return response.text();
    },

    /**
     * List every package of a type for an owner, following pagination.
     * @param {Object} options - Listing options
     * @param {{scope: string, name: string}} options.owner - Package owner
     * @param {string} options.packageType - GitHub package ecosystem
     * @returns {Promise<Array<Object>>} Packages, possibly empty
     */
    async listPackages({ owner, packageType }) {
      const packages = [];

      for (let page = 1; ; page += 1) {
        const query = `package_type=${encodeURIComponent(packageType)}&per_page=${PER_PAGE}&page=${page}`;
        const batch = await request(`${ownerPath(owner)}/packages?${query}`);

        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }

        packages.push(...batch);

        if (batch.length < PER_PAGE) {
          break;
        }
      }

      return packages;
    },

    /**
     * Read one package, returning null when it does not exist.
     * @param {Object} options - Read options
     * @param {{scope: string, name: string}} options.owner - Package owner
     * @param {string} options.packageType - GitHub package ecosystem
     * @param {string} options.packageName - Package name
     * @returns {Promise<Object|null>} Package payload or null
     */
    getPackage({ owner, packageType, packageName }) {
      const apiPath = `${ownerPath(owner)}/packages/${encodeURIComponent(packageType)}/${encodeURIComponent(packageName)}`;
      return request(apiPath, { allowNotFound: true });
    },
  };
}
