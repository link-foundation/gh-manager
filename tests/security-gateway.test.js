/**
 * The security gateway: which half of GitHub performs a change, and what is
 * accepted afterwards as proof that it happened.
 *
 * The fake GitHub behind these tests serves its API from the same state its
 * settings page mutates, so "verified" here means what it means in a real run:
 * a read that came back after the write and agreed with it.
 */

import { describe, it, expect } from 'test-anywhere';

import { EXIT_CODES } from '../src/exit-codes.js';
import { createLogger } from '../src/logging.js';
import { createSecurityGateway } from '../src/security/gateway.js';
import { findSecurityFeature } from '../src/security/features.js';
import { createFakeSession } from './fixtures/fake-browser.js';
import { securityGitHub } from './fixtures/github-security-pages.js';

const log = createLogger({
  verbose: false,
  stdout: () => {},
  stderr: () => {},
});

const graph = findSecurityFeature('dependency-graph');
const alerts = findSecurityFeature('vulnerability-alerts');
const scanning = findSecurityFeature('secret-scanning');
const protection = findSecurityFeature('push-protection');

/**
 * Build a gateway over a fake GitHub, counting the browser sessions it opens.
 * @param {Object} [options] - Options for securityGitHub
 * @returns {Object} GitHub, gateway, and the sessions that were opened
 */
function gatewayFor(options = {}) {
  const github = securityGitHub(options);
  const sessions = [];

  const gateway = createSecurityGateway({
    repo: github.repo,
    rest: github.rest,
    log,
    getSession: async () => {
      sessions[0] ??= createFakeSession({ routes: github.routes });
      return sessions[0];
    },
    verificationTimeout: 0,
  });

  return { github, gateway, sessions };
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

describe('reading security settings', () => {
  it('answers from the API without opening a browser', async () => {
    const { gateway, sessions } = gatewayFor({
      states: { 'vulnerability-alerts': 'enabled' },
    });

    expect(await gateway.readFeature(alerts)).toEqual({
      id: 'vulnerability-alerts',
      label: alerts.label,
      state: 'enabled',
      source: 'api',
    });
    expect(sessions.length).toBe(0);
  });

  it('falls back to the settings page when the token may not read', async () => {
    const { gateway, sessions } = gatewayFor({
      apiRead: false,
      states: { 'dependency-graph': 'enabled' },
    });

    const status = await gateway.readFeature(graph);

    expect(status.state).toBe('enabled');
    expect(status.source).toBe('page');
    expect(sessions.length).toBe(1);
  });

  it('reads the page once for a whole status listing', async () => {
    const { gateway, sessions } = gatewayFor({ apiRead: false });
    const statuses = await gateway.readAll();

    expect(statuses.map((status) => status.id)).toEqual([
      'dependency-graph',
      'vulnerability-alerts',
      'automated-security-fixes',
      'secret-scanning',
      'push-protection',
    ]);
    expect(statuses.every((status) => status.state === 'disabled')).toBe(true);
    expect(sessions[0].visited.length).toBe(1);
  });
});

describe('changing a security setting', () => {
  it('uses the API where an endpoint exists, and never the browser', async () => {
    const { github, gateway, sessions } = gatewayFor();

    const result = await gateway.setFeature({
      feature: alerts,
      enabled: true,
    });

    expect(result).toEqual({
      feature: 'vulnerability-alerts',
      state: 'enabled',
      changed: true,
      changedBy: 'api',
      verifiedBy: 'api',
    });
    expect(github.state.features['vulnerability-alerts']).toBe('enabled');
    expect(sessions.length).toBe(0);
  });

  it('patches the repository for a security_and_analysis toggle', async () => {
    const { github, gateway } = gatewayFor();

    const result = await gateway.setFeature({
      feature: scanning,
      enabled: true,
    });

    expect(result.changedBy).toBe('api');
    expect(github.state.features['secret-scanning']).toBe('enabled');
    expect(github.state.writes[0].method).toBe('PATCH');
  });

  it('flips the dependency graph in the browser and proves it with the SBOM', async () => {
    const { github, gateway } = gatewayFor();

    const result = await gateway.setFeature({ feature: graph, enabled: true });

    expect(result).toEqual({
      feature: 'dependency-graph',
      state: 'enabled',
      changed: true,
      changedBy: 'browser',
      verifiedBy: 'api',
    });
    expect(github.state.clicks).toEqual([
      { feature: 'dependency-graph', action: 'enable' },
    ]);
  });

  it('accepts the page as proof while the SBOM is still being built', async () => {
    const { github, gateway } = gatewayFor({ sbomReady: false });

    const result = await gateway.setFeature({ feature: graph, enabled: true });

    expect(result.changed).toBe(true);
    expect(result.verifiedBy).toBe('page');
    expect(github.state.features['dependency-graph']).toBe('enabled');
  });

  it('falls back to the browser when the API refuses the write', async () => {
    const { github, gateway } = gatewayFor({ apiWrite: false });

    const result = await gateway.setFeature({ feature: alerts, enabled: true });

    expect(result.changedBy).toBe('browser');
    expect(result.verifiedBy).toBe('api');
    expect(github.state.clicks).toEqual([
      { feature: 'vulnerability-alerts', action: 'enable' },
    ]);
  });

  it('changes nothing when the feature already has the wanted state', async () => {
    const { github, gateway, sessions } = gatewayFor({
      states: { 'vulnerability-alerts': 'enabled' },
    });

    const result = await gateway.setFeature({ feature: alerts, enabled: true });

    expect(result).toEqual({
      feature: 'vulnerability-alerts',
      state: 'enabled',
      changed: false,
      changedBy: null,
      verifiedBy: 'api',
    });
    expect(github.state.writes).toEqual([]);
    expect(sessions.length).toBe(0);
  });

  it('turns a feature off again', async () => {
    const { github, gateway } = gatewayFor({
      states: { 'vulnerability-alerts': 'enabled' },
    });

    const result = await gateway.setFeature({
      feature: alerts,
      enabled: false,
    });

    expect(result.state).toBe('disabled');
    expect(github.state.features['vulnerability-alerts']).toBe('disabled');
  });

  it('names the prerequisite GitHub would have refused the change for', async () => {
    const { github, gateway } = gatewayFor();

    const error = await failureOf(() =>
      gateway.setFeature({ feature: protection, enabled: true })
    );

    expect(error.exitCode).toBe(EXIT_CODES.FAILURE);
    expect(error.message).toContain('needs "Secret scanning"');
    expect(error.message).toContain('security secret-scanning');
    expect(github.state.writes).toEqual([]);
  });

  it('reports a change the API contradicts as unverified', async () => {
    const github = securityGitHub();
    const gateway = createSecurityGateway({
      repo: github.repo,
      log,
      // A GitHub that keeps answering "off" for everything, whatever is done
      // to it, is what an accepted-but-ineffective write looks like.
      rest: {
        hasToken: true,
        send: async () => ({ status: 404, ok: false, body: {} }),
      },
      getSession: async () => createFakeSession({ routes: github.routes }),
      verificationTimeout: 0,
    });

    const error = await failureOf(() =>
      gateway.setFeature({ feature: alerts, enabled: true })
    );

    expect(error.exitCode).toBe(EXIT_CODES.VERIFICATION_FAILED);
    expect(error.message).toContain('still reports "disabled"');
  });
});
