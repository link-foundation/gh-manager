/**
 * Minimal GitHub REST client for the read half of the tool.
 *
 * Reading package state through the API is faster and far more reliable than
 * scraping it, so every read goes through here first. The write half stays in
 * the browser because GitHub exposes no API for it.
 */

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
   * Perform one API request.
   * @param {string} apiPath - Path beginning with a slash
   * @param {Object} [options] - Request options
   * @param {boolean} [options.allowNotFound] - Return null for a 404
   * @returns {Promise<any>} Parsed JSON body, or null for a tolerated 404
   */
  async function request(apiPath, { allowNotFound = false } = {}) {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'gh-manager',
    };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const response = await fetchImpl(`${baseUrl}${apiPath}`, { headers });

    if (response.status === 404 && allowNotFound) {
      return null;
    }

    if (!response.ok) {
      throw new GitHubApiError(`GitHub API ${response.status} for ${apiPath}`, {
        status: response.status,
        path: apiPath,
      });
    }

    return response.json();
  }

  return {
    hasToken: Boolean(token),
    request,

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
