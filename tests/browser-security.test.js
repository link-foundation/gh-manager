/**
 * The code security settings driver.
 *
 * These tests are the ones that stand between the tool and the worst thing it
 * could do: click a control that belongs to a feature nobody named. Each case
 * acts through the shipped driver against a page that holds real state, and
 * then asserts on which button was clicked and on what actually changed.
 */

import { describe, it, expect } from 'test-anywhere';

import { EXIT_CODES } from '../src/exit-codes.js';
import { createLogger } from '../src/logging.js';
import {
  readSecurityFeatures,
  setSecurityFeature,
} from '../src/browser/security-settings.js';
import { findSecurityFeature } from '../src/security/features.js';
import { createFakeSession } from './fixtures/fake-browser.js';
import { securityPages } from './fixtures/github-security-pages.js';

const log = createLogger({
  verbose: false,
  stdout: () => {},
  stderr: () => {},
});

const graph = findSecurityFeature('dependency-graph');
const alerts = findSecurityFeature('vulnerability-alerts');

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

describe('readSecurityFeatures', () => {
  it('reads the state of every toggle on the page', async () => {
    const pages = securityPages({
      states: { 'vulnerability-alerts': 'enabled' },
    });
    const session = createFakeSession({ routes: pages.routes });

    const rows = await readSecurityFeatures(session, {
      repo: pages.repo,
      log,
    });

    expect(rows['dependency-graph'].found).toBe(true);
    expect(rows['dependency-graph'].state).toBe('disabled');
    expect(rows['vulnerability-alerts'].state).toBe('enabled');
    expect(rows['secret-scanning'].locked).toBe(false);
    expect(session.visited).toEqual([
      'https://github.com/link-foundation/gh-manager/settings/security_analysis',
    ]);
  });

  it('reports a toggle an organization policy owns as locked', async () => {
    const pages = securityPages({ locked: ['dependency-graph'] });
    const session = createFakeSession({ routes: pages.routes });

    const rows = await readSecurityFeatures(session, {
      repo: pages.repo,
      log,
    });

    expect(rows['dependency-graph'].locked).toBe(true);
    expect(rows['vulnerability-alerts'].locked).toBe(false);
  });

  it('fails with artifacts when the page shows no toggles at all', async () => {
    const pages = securityPages({ admin: false });
    const session = createFakeSession({ routes: pages.routes });

    const error = await failureOf(() =>
      readSecurityFeatures(session, { repo: pages.repo, log })
    );

    expect(error.message).toContain('none of the expected toggles');
    expect(session.captures).toEqual(['security settings of gh-manager']);
  });

  it('fails with the auth exit code when the profile is signed out', async () => {
    const pages = securityPages({ login: null });
    const session = createFakeSession({ routes: pages.routes });

    const error = await failureOf(() =>
      readSecurityFeatures(session, { repo: pages.repo, log })
    );

    expect(error.exitCode).toBe(EXIT_CODES.AUTH);
  });

  it('reports a repository it cannot see as missing', async () => {
    const session = createFakeSession({ routes: {} });

    const error = await failureOf(() =>
      readSecurityFeatures(session, {
        repo: { owner: 'link-foundation', name: 'gh-manager' },
        log,
      })
    );

    expect(error.message).toContain('does not exist');
    expect(error.exitCode).toBe(EXIT_CODES.FAILURE);
  });
});

describe('setSecurityFeature', () => {
  it('clicks the enable button of the named feature and waits for it to flip', async () => {
    const pages = securityPages({});
    const session = createFakeSession({ routes: pages.routes });

    const result = await setSecurityFeature(session, {
      repo: pages.repo,
      feature: graph,
      enabled: true,
      log,
    });

    expect(pages.state.features['dependency-graph']).toBe('enabled');
    expect(pages.state.features['vulnerability-alerts']).toBe('disabled');
    expect(pages.state.clicks).toEqual([
      { feature: 'dependency-graph', action: 'enable' },
    ]);
    expect(result).toEqual({ changed: true, reported: 'enabled' });
  });

  it('turns a feature off through its disable button', async () => {
    const pages = securityPages({
      states: { 'vulnerability-alerts': 'enabled' },
    });
    const session = createFakeSession({ routes: pages.routes });

    const result = await setSecurityFeature(session, {
      repo: pages.repo,
      feature: alerts,
      enabled: false,
      log,
    });

    expect(pages.state.features['vulnerability-alerts']).toBe('disabled');
    expect(pages.state.clicks).toEqual([
      { feature: 'vulnerability-alerts', action: 'disable' },
    ]);
    expect(result).toEqual({ changed: true, reported: 'disabled' });
  });

  it('clicks nothing when the feature already has the requested state', async () => {
    const pages = securityPages({ states: { 'dependency-graph': 'enabled' } });
    const session = createFakeSession({ routes: pages.routes });

    const result = await setSecurityFeature(session, {
      repo: pages.repo,
      feature: graph,
      enabled: true,
      log,
    });

    expect(result).toEqual({ changed: false, reported: 'enabled' });
    expect(pages.state.clicks).toEqual([]);
  });

  it('never clicks the page-wide "Enable all" button', async () => {
    // "Enable all" carries the wording of the per-feature buttons and would
    // switch on every protection in one click, so the labels are matched whole.
    const pages = securityPages({
      enableAll: true,
      uncontrollable: ['dependency-graph'],
    });
    const session = createFakeSession({ routes: pages.routes });

    const error = await failureOf(() =>
      setSecurityFeature(session, {
        repo: pages.repo,
        feature: graph,
        enabled: true,
        log,
      })
    );

    expect(error.message).toContain('no "Dependency graph" row');
    expect(pages.state.clicks).toEqual([]);
  });

  it('refuses a row that names more than one feature', async () => {
    const pages = securityPages({
      grouped: ['dependency-graph', 'vulnerability-alerts'],
    });
    const session = createFakeSession({ routes: pages.routes });

    const error = await failureOf(() =>
      setSecurityFeature(session, {
        repo: pages.repo,
        feature: graph,
        enabled: true,
        log,
      })
    );

    expect(error.message).toContain('(ambiguous-row)');
    expect(pages.state.clicks).toEqual([]);
    expect(session.captures.length).toBe(1);
  });

  it('refuses a toggle an organization policy owns', async () => {
    const pages = securityPages({ locked: ['dependency-graph'] });
    const session = createFakeSession({ routes: pages.routes });

    const error = await failureOf(() =>
      setSecurityFeature(session, {
        repo: pages.repo,
        feature: graph,
        enabled: true,
        log,
      })
    );

    expect(error.message).toContain(
      'governed by an organization or enterprise policy'
    );
    expect(error.exitCode).toBe(EXIT_CODES.FAILURE);
    expect(pages.state.clicks).toEqual([]);
    expect(pages.state.features['dependency-graph']).toBe('disabled');
  });
});
