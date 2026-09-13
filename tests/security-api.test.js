/**
 * What the API can and cannot say about a repository's security settings.
 *
 * The distinction every test here defends is between "off" and "unreadable":
 * a 403 from a token without the `security_events` scope must never be
 * reported as a disabled toggle, because the tool would then claim to have
 * turned on something it never touched.
 */

import { describe, it, expect } from 'test-anywhere';

import { repoPath } from '../src/github/rest.js';
import {
  canWriteThroughApi,
  readFeatureThroughApi,
  writeFeatureThroughApi,
} from '../src/security/api.js';
import { findSecurityFeature } from '../src/security/features.js';
import { restClientFor } from './fixtures/fake-github-api.js';

const repo = { owner: 'link-foundation', name: 'gh-manager' };
const base = repoPath(repo);

const graph = findSecurityFeature('dependency-graph');
const alerts = findSecurityFeature('vulnerability-alerts');
const fixes = findSecurityFeature('automated-security-fixes');
const scanning = findSecurityFeature('secret-scanning');

/**
 * Read one feature against a route table.
 * @param {Object} routes - Route table
 * @param {Object} feature - Feature definition
 * @param {Object} [options] - Client options
 * @returns {Promise<Object>} Read outcome
 */
function read(routes, feature, options = {}) {
  return readFeatureThroughApi(restClientFor(routes, options), {
    repo,
    feature,
  });
}

describe('repoPath', () => {
  it('escapes both halves of the slug', () => {
    expect(repoPath({ owner: 'a b', name: 'c/d' })).toBe('/repos/a%20b/c%2Fd');
  });
});

describe('readFeatureThroughApi', () => {
  it('reads a 204 from the toggle endpoint as enabled', async () => {
    const outcome = await read(
      { [`${base}/vulnerability-alerts`]: { status: 204 } },
      alerts
    );

    expect(outcome).toEqual({ state: 'enabled' });
  });

  it('reads a 404 from the toggle endpoint as disabled', async () => {
    const outcome = await read(
      { [`${base}/vulnerability-alerts`]: { status: 404, body: {} } },
      alerts
    );

    expect(outcome).toEqual({ state: 'disabled' });
  });

  it('reads the body of the endpoint that answers 200 either way', async () => {
    const outcome = await read(
      {
        [`${base}/automated-security-fixes`]: {
          status: 200,
          body: { enabled: false, paused: false },
        },
      },
      fixes
    );

    expect(outcome).toEqual({ state: 'disabled' });
  });

  it('treats an SBOM as proof that the dependency graph is on', async () => {
    const outcome = await read(
      {
        [`${base}/dependency-graph/sbom`]: {
          status: 200,
          body: { sbom: { packages: [] } },
        },
      },
      graph
    );

    expect(outcome).toEqual({ state: 'enabled' });
  });

  it('reads secret scanning out of security_and_analysis', async () => {
    const outcome = await read(
      {
        [base]: {
          status: 200,
          body: {
            security_and_analysis: { secret_scanning: { status: 'enabled' } },
          },
        },
      },
      scanning
    );

    expect(outcome).toEqual({ state: 'enabled' });
  });

  it('answers unknown when the repository omits the analysis block', async () => {
    const outcome = await read({ [base]: { status: 200, body: {} } }, scanning);

    expect(outcome).toEqual({ state: 'unknown', reason: 'not-reported' });
  });

  it('answers unknown when the token may not ask', async () => {
    const outcome = await read(
      { [`${base}/vulnerability-alerts`]: { status: 403, body: {} } },
      alerts
    );

    expect(outcome).toEqual({ state: 'unknown', reason: 'http-403' });
  });

  it('answers unknown without a token', async () => {
    const outcome = await read({}, alerts, { token: null });

    expect(outcome).toEqual({ state: 'unknown', reason: 'no-token' });
  });

  it('answers unknown when the request itself fails', async () => {
    const outcome = await readFeatureThroughApi(
      {
        hasToken: true,
        send: async () => {
          throw new Error('socket hang up');
        },
      },
      { repo, feature: alerts }
    );

    expect(outcome.state).toBe('unknown');
    expect(outcome.reason).toContain('socket hang up');
  });
});

describe('canWriteThroughApi', () => {
  it('refuses the dependency graph, which has no endpoint', () => {
    expect(canWriteThroughApi({ hasToken: true }, graph)).toBe(false);
  });

  it('accepts a feature with an endpoint and a token', () => {
    expect(canWriteThroughApi({ hasToken: true }, alerts)).toBe(true);
  });

  it('refuses any feature without a token', () => {
    expect(canWriteThroughApi({ hasToken: false }, alerts)).toBe(false);
  });
});

describe('writeFeatureThroughApi', () => {
  it('PUTs a toggle on and DELETEs it off', async () => {
    const rest = restClientFor({
      [`PUT ${base}/vulnerability-alerts`]: { status: 204 },
      [`DELETE ${base}/vulnerability-alerts`]: { status: 204 },
    });

    expect(
      await writeFeatureThroughApi(rest, {
        repo,
        feature: alerts,
        enabled: true,
      })
    ).toEqual({ written: true });
    expect(
      await writeFeatureThroughApi(rest, {
        repo,
        feature: alerts,
        enabled: false,
      })
    ).toEqual({ written: true });
    expect(rest.fetchImpl.calls.map((call) => call.method)).toEqual([
      'PUT',
      'DELETE',
    ]);
  });

  it('PATCHes the repository for a security_and_analysis property', async () => {
    const rest = restClientFor({
      [`PATCH ${base}`]: { status: 200, body: {} },
    });

    await writeFeatureThroughApi(rest, {
      repo,
      feature: scanning,
      enabled: true,
    });

    expect(rest.fetchImpl.calls[0].body).toEqual({
      security_and_analysis: { secret_scanning: { status: 'enabled' } },
    });
  });

  it('reports a refusal without throwing, so the browser can try', async () => {
    const rest = restClientFor({
      [`PUT ${base}/vulnerability-alerts`]: { status: 403, body: {} },
    });

    expect(
      await writeFeatureThroughApi(rest, {
        repo,
        feature: alerts,
        enabled: true,
      })
    ).toEqual({ written: false, reason: 'http-403' });
  });
});
