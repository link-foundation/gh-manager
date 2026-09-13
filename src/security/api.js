/**
 * What the GitHub API can say about a repository's security settings.
 *
 * Every read here returns one of three answers — `enabled`, `disabled`, or
 * `unknown` — and never collapses the third into the second. "The token may
 * not ask" and "the feature is off" are different facts, and treating a 403 as
 * proof that a toggle is off would let the tool report a change it never made.
 */

import { repoPath } from '../github/rest.js';

/** A read that reached no conclusion. */
const unknown = (reason) => ({ state: 'unknown', reason });

/** A read that concluded. */
const known = (enabled) => ({ state: enabled ? 'enabled' : 'disabled' });

/**
 * Read a toggle endpoint, which answers `204` for on and `404` for off.
 * @param {Object} rest - REST client
 * @param {Object} options - Read options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.feature - Feature definition
 * @returns {Promise<{state: string, reason?: string}>} Read outcome
 */
async function readToggle(rest, { repo, feature }) {
  const response = await rest.send(`${repoPath(repo)}/${feature.read.path}`);

  if (response.status === 204) {
    return known(true);
  }

  if (response.status === 404) {
    return known(false);
  }

  if (response.ok) {
    // `automated-security-fixes` answers 200 with `{enabled, paused}` rather
    // than carrying the answer in the status.
    return typeof response.body?.enabled === 'boolean'
      ? known(response.body.enabled)
      : unknown('unreadable-body');
  }

  return unknown(`http-${response.status}`);
}

/**
 * Probe the dependency graph by asking for the SBOM it makes possible.
 *
 * GitHub exposes no endpoint that reports the toggle itself, so the SBOM is
 * the evidence: the endpoint answers with a document while the graph is on,
 * and 404 while it is off.
 * @param {Object} rest - REST client
 * @param {Object} options - Read options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.feature - Feature definition
 * @returns {Promise<{state: string, reason?: string}>} Read outcome
 */
async function readSbom(rest, { repo, feature }) {
  const response = await rest.send(`${repoPath(repo)}/${feature.read.path}`);

  if (response.ok) {
    return known(true);
  }

  if (response.status === 404) {
    return known(false);
  }

  return unknown(`http-${response.status}`);
}

/**
 * Read a `security_and_analysis` property of the repository itself.
 * @param {Object} rest - REST client
 * @param {Object} options - Read options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.feature - Feature definition
 * @returns {Promise<{state: string, reason?: string}>} Read outcome
 */
async function readAnalysis(rest, { repo, feature }) {
  const response = await rest.send(repoPath(repo));

  if (!response.ok) {
    return unknown(`http-${response.status}`);
  }

  const status =
    response.body?.security_and_analysis?.[feature.read.property]?.status;

  if (status === 'enabled' || status === 'disabled') {
    return known(status === 'enabled');
  }

  return unknown('not-reported');
}

const READERS = {
  toggle: readToggle,
  sbom: readSbom,
  analysis: readAnalysis,
};

/**
 * Write a toggle endpoint: `PUT` turns it on, `DELETE` turns it off.
 * @param {Object} rest - REST client
 * @param {Object} options - Write options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.feature - Feature definition
 * @param {boolean} options.enabled - Desired state
 * @returns {Promise<{status: number, ok: boolean}>} Response
 */
function writeToggle(rest, { repo, feature, enabled }) {
  return rest.send(`${repoPath(repo)}/${feature.write.path}`, {
    method: enabled ? 'PUT' : 'DELETE',
  });
}

/**
 * Write a `security_and_analysis` property with a repository patch.
 * @param {Object} rest - REST client
 * @param {Object} options - Write options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.feature - Feature definition
 * @param {boolean} options.enabled - Desired state
 * @returns {Promise<{status: number, ok: boolean}>} Response
 */
function writeAnalysis(rest, { repo, feature, enabled }) {
  return rest.send(repoPath(repo), {
    method: 'PATCH',
    body: {
      security_and_analysis: {
        [feature.write.property]: {
          status: enabled ? 'enabled' : 'disabled',
        },
      },
    },
  });
}

const WRITERS = { toggle: writeToggle, analysis: writeAnalysis };

/**
 * Report whether the API can write this feature with the credentials at hand.
 * @param {Object} rest - REST client
 * @param {Object} feature - Feature definition
 * @returns {boolean} True when an API write is possible
 */
export function canWriteThroughApi(rest, feature) {
  return Boolean(rest.hasToken && feature.write && WRITERS[feature.write.kind]);
}

/**
 * Read one feature's state through the API.
 * @param {Object} rest - REST client
 * @param {Object} options - Read options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.feature - Feature definition
 * @returns {Promise<{state: string, reason?: string}>} Read outcome
 */
export async function readFeatureThroughApi(rest, { repo, feature }) {
  if (!rest.hasToken) {
    return unknown('no-token');
  }

  const reader = READERS[feature.read?.kind];

  if (!reader) {
    return unknown('no-endpoint');
  }

  try {
    return await reader(rest, { repo, feature });
  } catch (error) {
    return unknown(`request-failed: ${error.message}`);
  }
}

/**
 * Write one feature's state through the API.
 *
 * A refusal is reported, not thrown: the browser is the fallback for exactly
 * the cases the API declines, which is the whole premise of this tool.
 * @param {Object} rest - REST client
 * @param {Object} options - Write options
 * @param {{owner: string, name: string}} options.repo - Repository
 * @param {Object} options.feature - Feature definition
 * @param {boolean} options.enabled - Desired state
 * @returns {Promise<{written: boolean, reason?: string}>} Write outcome
 */
export async function writeFeatureThroughApi(rest, { repo, feature, enabled }) {
  const writer = WRITERS[feature.write?.kind];

  try {
    const response = await writer(rest, { repo, feature, enabled });
    return response.ok
      ? { written: true }
      : { written: false, reason: `http-${response.status}` };
  } catch (error) {
    return { written: false, reason: `request-failed: ${error.message}` };
  }
}
