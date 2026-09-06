/**
 * The per-package access driver.
 *
 * Permissions are the one part of this tool where a silent no-op is expensive:
 * a grant that never landed looks exactly like a grant that did. Every test
 * here therefore acts through the shipped driver and asserts on the access
 * rows the fixture ends up holding, not on the calls the driver made.
 */

import { describe, it, expect } from 'test-anywhere';

import { EXIT_CODES } from '../src/exit-codes.js';
import { createLogger } from '../src/logging.js';
import {
  grantPackageAccess,
  listPackageAccess,
  revokePackageAccess,
} from '../src/browser/package-access.js';
import { createFakeSession } from './fixtures/fake-browser.js';
import { packagePages } from './fixtures/github-pages.js';

const log = createLogger({
  verbose: false,
  stdout: () => {},
  stderr: () => {},
});

const DIRECTORY = [
  { type: 'team', name: 'maintainers' },
  { type: 'team', name: 'reviewers' },
  { type: 'user', name: 'konard' },
];

/**
 * Open a package whose settings page carries an access section.
 * @param {Object} [options] - Fixture options (see packagePages)
 * @returns {Object} Session, mutable state, and the driver's coordinates
 */
function accessFixture(options = {}) {
  const { state, routes, coordinates } = packagePages({
    packageName: 'box',
    directory: DIRECTORY,
    ...options,
  });

  return {
    state,
    session: createFakeSession({ routes }),
    options: { ...coordinates, log },
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

describe('listPackageAccess', () => {
  it('reads the teams and users that hold a role', async () => {
    const { session, options } = accessFixture({
      access: [
        { type: 'team', name: 'maintainers', role: 'admin' },
        { type: 'user', name: 'konard', role: 'read' },
      ],
    });

    expect(await listPackageAccess(session, options)).toEqual([
      { type: 'team', name: 'maintainers', role: 'admin' },
      { type: 'user', name: 'konard', role: 'read' },
    ]);
  });

  it('reports an empty list for a package nobody was invited to', async () => {
    const { session, options } = accessFixture();

    expect(await listPackageAccess(session, options)).toEqual([]);
  });
});

describe('grantPackageAccess', () => {
  it('invites a team that has no access yet', async () => {
    const { session, state, options } = accessFixture();

    const result = await grantPackageAccess(session, {
      ...options,
      grantee: { type: 'team', name: 'maintainers' },
      role: 'write',
    });

    expect(result).toEqual({ changed: true, role: 'write' });
    expect(state.access).toEqual([
      { type: 'team', name: 'maintainers', role: 'write' },
    ]);
  });

  it('leaves a grantee that already holds the role untouched', async () => {
    const { session, state, options } = accessFixture({
      access: [{ type: 'user', name: 'konard', role: 'admin' }],
    });

    const result = await grantPackageAccess(session, {
      ...options,
      grantee: { type: 'user', name: 'konard' },
      role: 'admin',
    });

    expect(result).toEqual({ changed: false, role: 'admin' });
    expect(state.submissions).toEqual([]);
  });

  it('replaces a different role by removing the row first', async () => {
    const { session, state, options } = accessFixture({
      access: [{ type: 'team', name: 'maintainers', role: 'read' }],
    });

    const result = await grantPackageAccess(session, {
      ...options,
      grantee: { type: 'team', name: 'maintainers' },
      role: 'admin',
    });

    expect(result).toEqual({ changed: true, role: 'admin' });
    expect(state.access).toEqual([
      { type: 'team', name: 'maintainers', role: 'admin' },
    ]);
    expect(state.submissions.map((entry) => entry.dialog)).toEqual([
      'remove-inline',
      'invite-dialog',
    ]);
  });

  it('tells one grantee from another with a similar name', async () => {
    const { session, state, options } = accessFixture({
      access: [{ type: 'team', name: 'reviewers', role: 'read' }],
    });

    await grantPackageAccess(session, {
      ...options,
      grantee: { type: 'team', name: 'maintainers' },
      role: 'read',
    });

    expect(state.access).toEqual([
      { type: 'team', name: 'reviewers', role: 'read' },
      { type: 'team', name: 'maintainers', role: 'read' },
    ]);
  });
});

describe('revokePackageAccess', () => {
  it('removes a row and reports the role that was taken away', async () => {
    const { session, state, options } = accessFixture({
      access: [
        { type: 'team', name: 'maintainers', role: 'admin' },
        { type: 'user', name: 'konard', role: 'read' },
      ],
    });

    const result = await revokePackageAccess(session, {
      ...options,
      grantee: { type: 'user', name: 'konard' },
    });

    expect(result).toEqual({ changed: true, role: 'read' });
    expect(state.access).toEqual([
      { type: 'team', name: 'maintainers', role: 'admin' },
    ]);
  });

  it('confirms the removal when GitHub asks for it', async () => {
    const { session, state, options } = accessFixture({
      removeVia: 'dialog',
      access: [{ type: 'team', name: 'maintainers', role: 'write' }],
    });

    const result = await revokePackageAccess(session, {
      ...options,
      grantee: { type: 'team', name: 'maintainers' },
    });

    expect(result).toEqual({ changed: true, role: 'write' });
    expect(state.access).toEqual([]);
    expect(state.submissions.map((entry) => entry.dialog)).toEqual([
      'remove-dialog',
    ]);
  });

  it('does nothing for a grantee that has no access', async () => {
    const { session, state, options } = accessFixture({
      access: [{ type: 'team', name: 'maintainers', role: 'write' }],
    });

    const result = await revokePackageAccess(session, {
      ...options,
      grantee: { type: 'user', name: 'konard' },
    });

    expect(result).toEqual({ changed: false, role: null });
    expect(state.submissions).toEqual([]);
  });

  it('fails with a screenshot when the row offers no way to remove', async () => {
    const { session, state, options } = accessFixture({
      removeVia: 'nowhere',
      access: [{ type: 'team', name: 'maintainers', role: 'write' }],
    });

    const error = await failureOf(() =>
      revokePackageAccess(session, {
        ...options,
        grantee: { type: 'team', name: 'maintainers' },
      })
    );

    expect(error.exitCode).toBe(EXIT_CODES.FAILURE);
    expect(error.message).toContain('No control to remove team maintainers');
    expect(session.captures.length).toBe(1);
    expect(state.access.length).toBe(1);
  });
});
