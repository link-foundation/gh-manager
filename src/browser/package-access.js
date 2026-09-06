/**
 * Per-package access for teams and users.
 *
 * GitHub has no API for package permissions either, so this drives the access
 * section of the package settings page. Every change is verified by re-reading
 * the rows afterwards: an unverified grant is indistinguishable from a silent
 * no-op, and this tool never reports one as success.
 */

import { EXIT_CODES } from '../exit-codes.js';
import {
  clickMarked,
  clickTarget,
  failWithArtifacts,
  fillTarget,
  pollFor,
} from './actions.js';
import { markAccessRowControl, markTarget, readAccessRows } from './dom.js';
import {
  confirmDialog,
  dialogScope,
  openPackageSettings,
  readOpenDialog,
} from './package-settings.js';
import { ROLES, SELECTORS } from './selectors.js';

/** Labels of the control that removes a grantee from a package. */
const REMOVE_LABELS = ['remove', 'revoke'];

/**
 * Build a target descriptor that matches an element by its wording.
 * @param {string} value - Text the element should contain
 * @returns {{selectors: string[], texts: string[], preferText: boolean}} Descriptor
 */
function textTarget(value) {
  return {
    selectors: [],
    texts: [String(value).toLowerCase()],
    preferText: true,
  };
}

/**
 * Read the access rows of the settings page that is already open.
 * @param {Object} session - Browser session
 * @returns {Promise<Array<{type: string, name: string, role: string}>>} Rows
 */
function readRows(session) {
  return readAccessRows(session.commander, { roles: ROLES });
}

/**
 * Read the role one grantee currently holds on the open package.
 * @param {Object} session - Browser session
 * @param {{type: string, name: string}} grantee - Team or user
 * @returns {Promise<string|null>} Role, or null when the grantee has no access
 */
async function readGranteeRole(session, grantee) {
  const rows = await readRows(session);
  const row = rows.find(
    (candidate) =>
      candidate.type === grantee.type &&
      candidate.name.toLowerCase() === grantee.name.toLowerCase()
  );

  return row ? row.role : null;
}

/**
 * List the teams and users that have access to a package.
 * @param {Object} session - Browser session
 * @param {Object} options - Package coordinates and logger
 * @returns {Promise<Array<{type: string, name: string, role: string}>>} Rows
 */
export async function listPackageAccess(session, options) {
  await openPackageSettings(session, options);
  return readRows(session);
}

/**
 * Wait until the settings page reports the expected role for a grantee.
 * @param {Object} session - Browser session
 * @param {Object} options - Verification options
 * @param {{type: string, name: string}} options.grantee - Team or user
 * @param {string|null} options.expected - Expected role, or null for no access
 * @param {string} options.label - Label describing the operation
 * @returns {Promise<void>} Resolves once the page agrees
 */
async function verifyRole(session, { grantee, expected, label }) {
  const { value, accepted } = await pollFor(session, {
    read: () => readGranteeRole(session, grantee),
    accept: (role) => role === expected,
  });

  if (!accepted) {
    await failWithArtifacts(session, {
      label,
      message: `GitHub reports ${value ? `"${value}"` : 'no access'} for ${grantee.type} ${grantee.name}; the expected access is ${expected ? `"${expected}"` : 'none'}.`,
      exitCode: EXIT_CODES.VERIFICATION_FAILED,
    });
  }
}

/**
 * Pick an entry out of the invite dialog's search results.
 * @param {Object} session - Browser session
 * @param {Object} options - Selection options
 * @param {string} options.name - Team or user name to pick
 * @param {string} options.label - Label describing the operation
 * @returns {Promise<void>} Resolves after clicking the entry
 */
async function pickSearchResult(session, { name, label }) {
  const { accepted } = await pollFor(session, {
    read: () =>
      markTarget(session.commander, {
        target: textTarget(name),
        scopeSelectors: dialogScope(),
      }),
    accept: (match) => match.found,
  });

  if (!accepted) {
    await failWithArtifacts(session, {
      label,
      message: `GitHub's search returned no entry named "${name}".`,
    });
  }

  await clickMarked(session, { label: `${label}: search result` });
}

/**
 * Run the invite flow for one grantee and role.
 * @param {Object} session - Browser session
 * @param {Object} options - Invite options
 * @param {{type: string, name: string}} options.grantee - Team or user
 * @param {string} options.role - Role to grant
 * @param {string} options.label - Label describing the operation
 * @returns {Promise<void>} Resolves after submitting the invite
 */
async function inviteGrantee(session, { grantee, role, label }) {
  await clickTarget(session, {
    target: SELECTORS.inviteButton,
    label: `${label}: invite button`,
  });

  const { accepted } = await pollFor(session, {
    read: () => readOpenDialog(session),
    accept: (dialog) => dialog.open,
  });

  if (!accepted) {
    await failWithArtifacts(session, {
      label,
      message: 'GitHub did not open the invite dialog.',
    });
  }

  await fillTarget(session, {
    target: SELECTORS.inviteInput,
    label: `${label}: search field`,
    value: grantee.name,
    scopeSelectors: dialogScope(),
  });

  await pickSearchResult(session, { name: grantee.name, label });

  await clickTarget(session, {
    target: textTarget(role),
    label: `${label}: role ${role}`,
    scopeSelectors: dialogScope(),
  });

  await clickTarget(session, {
    target: SELECTORS.inviteConfirmButton,
    label: `${label}: confirm`,
    scopeSelectors: dialogScope(),
    waitForNavigation: true,
  });
}

/**
 * Remove a grantee's access row.
 * @param {Object} session - Browser session
 * @param {Object} options - Removal options
 * @param {{type: string, name: string}} options.grantee - Team or user
 * @param {string} options.label - Label describing the operation
 * @returns {Promise<void>} Resolves after submitting the removal
 */
async function removeGrantee(session, { grantee, label }) {
  const marked = await markAccessRowControl(session.commander, {
    grantee,
    labels: REMOVE_LABELS,
  });

  if (!marked.found) {
    await failWithArtifacts(session, {
      label,
      message: `No control to remove ${grantee.type} ${grantee.name} was found (${marked.reason}).`,
    });
  }

  await clickMarked(session, { label: `${label}: remove` });

  const dialog = await readOpenDialog(session);

  if (dialog.open) {
    await confirmDialog(session, {
      label,
      confirmTarget: {
        selectors: ['button[type="submit"]'],
        texts: ['remove', 'confirm', 'yes'],
        preferText: true,
      },
    });
  }
}

/**
 * Give a team or user a role on a package.
 *
 * A grantee that already holds a different role is removed first, because the
 * invite flow is the only path whose wording is stable enough to drive: role
 * pickers inside a row differ between a select, a menu, and a dialog.
 * @param {Object} session - Browser session
 * @param {Object} options - Operation options
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {string} options.packageName - Package name
 * @param {{type: string, name: string}} options.grantee - Team or user
 * @param {string} options.role - Role to grant
 * @param {Object} options.log - Logger
 * @returns {Promise<{changed: boolean, role: string}>} Outcome
 */
export async function grantPackageAccess(session, options) {
  const { grantee, role, packageName } = options;
  await openPackageSettings(session, options);

  const label = `grant ${role} on ${packageName} to ${grantee.type} ${grantee.name}`;
  const existing = await readGranteeRole(session, grantee);

  if (existing === role) {
    return { changed: false, role };
  }

  if (existing) {
    options.log.debug(`replacing role "${existing}" with "${role}"`);
    await removeGrantee(session, { grantee, label });
    await verifyRole(session, { grantee, expected: null, label });
  }

  await inviteGrantee(session, { grantee, role, label });
  await verifyRole(session, { grantee, expected: role, label });

  return { changed: true, role };
}

/**
 * Take a team's or user's access to a package away.
 * @param {Object} session - Browser session
 * @param {Object} options - Operation options (see grantPackageAccess)
 * @returns {Promise<{changed: boolean, role: string|null}>} Outcome
 */
export async function revokePackageAccess(session, options) {
  const { grantee, packageName } = options;
  await openPackageSettings(session, options);

  const label = `revoke access to ${packageName} from ${grantee.type} ${grantee.name}`;
  const existing = await readGranteeRole(session, grantee);

  if (!existing) {
    return { changed: false, role: null };
  }

  await removeGrantee(session, { grantee, label });
  await verifyRole(session, { grantee, expected: null, label });

  return { changed: true, role: existing };
}
