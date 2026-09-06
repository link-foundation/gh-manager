/**
 * The package settings page.
 *
 * Changing a package's visibility and deleting a package are the two
 * operations GitHub exposes nowhere but this page: no REST endpoint, no
 * GraphQL mutation, no `gh` command. Both follow the same shape — open a
 * dialog, satisfy its confirmation, submit — so that shape is written once.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';
import {
  assertSignedIn,
  clickTarget,
  failWithArtifacts,
  fillTarget,
  gotoUrl,
  pollFor,
} from './actions.js';
import {
  confirmationPhrase,
  markTarget,
  readDialog,
  readPageState,
  readReportedVisibility,
  selectVisibilityRadio,
} from './dom.js';
import { SELECTORS, packageSettingsUrls, packageUrl } from './selectors.js';

const DIALOG_SCOPE = SELECTORS.openDialog.selectors;

/** Danger-zone controls whose presence proves the settings page is open. */
const SETTINGS_MARKERS = [
  SELECTORS.changeVisibilityButton,
  SELECTORS.deletePackageButton,
];

/**
 * Report whether the page currently open is a package settings page.
 * @param {Object} session - Browser session
 * @returns {Promise<boolean>} True when a danger-zone control is present
 */
async function isSettingsPage(session) {
  for (const target of SETTINGS_MARKERS) {
    const match = await markTarget(session.commander, { target });

    if (match.found) {
      return true;
    }
  }

  return false;
}

/**
 * Open the settings page of a package.
 *
 * The direct settings URLs are tried first because they are one navigation
 * each; following the link from the package page is the fallback for when
 * GitHub moves them again.
 * @param {Object} session - Browser session
 * @param {Object} options - Package coordinates
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {string} options.packageName - Package name
 * @param {Object} options.log - Logger
 * @returns {Promise<string>} URL of the settings page that was opened
 */
export async function openPackageSettings(
  session,
  { owner, packageType, packageName, log }
) {
  const coordinates = { owner, packageType, packageName };

  for (const url of packageSettingsUrls(coordinates)) {
    const landed = await gotoUrl(session, url);
    const state = await readPageState(session.commander);
    assertSignedIn(state);

    if (!state.notFound && (await isSettingsPage(session))) {
      log.debug(`settings page open: ${landed}`);
      return landed;
    }

    log.debug(`not a settings page: ${landed}`);
  }

  const landed = await gotoUrl(session, packageUrl(coordinates));
  const state = await readPageState(session.commander);
  assertSignedIn(state);

  if (state.notFound) {
    throw new CliError(
      `Package ${owner.name}/${packageName} does not exist, or is not visible to ${state.login}`,
      EXIT_CODES.FAILURE
    );
  }

  log.debug(`following the settings link from ${landed}`);
  await clickTarget(session, {
    target: SELECTORS.settingsLink,
    label: `settings link of ${packageName}`,
    waitForNavigation: true,
  });

  if (!(await isSettingsPage(session))) {
    await failWithArtifacts(session, {
      label: `settings of ${packageName}`,
      message: `Could not reach the settings page of ${owner.name}/${packageName}. The account may lack admin rights on the package.`,
    });
  }

  return session.commander.getUrl();
}

/**
 * Selectors that identify an open GitHub dialog.
 * @returns {string[]} Dialog container selectors
 */
export function dialogScope() {
  return DIALOG_SCOPE;
}

/**
 * Read the dialog that is currently open, if any.
 * @param {Object} session - Browser session
 * @returns {Promise<{open: boolean, text: string, inputs: number}>} Dialog state
 */
export function readOpenDialog(session) {
  return readDialog(session.commander, DIALOG_SCOPE);
}

/**
 * Click a danger-zone button and wait for its dialog to open.
 * @param {Object} session - Browser session
 * @param {Object} options - Dialog options
 * @param {Object} options.target - Descriptor of the button that opens the dialog
 * @param {string} options.label - Label describing the operation
 * @returns {Promise<{open: boolean, text: string, inputs: number}>} Dialog state
 */
async function openDialog(session, { target, label }) {
  await clickTarget(session, { target, label });

  const { value, accepted } = await pollFor(session, {
    read: () => readDialog(session.commander, DIALOG_SCOPE),
    accept: (dialog) => dialog.open,
  });

  if (!accepted) {
    await failWithArtifacts(session, {
      label,
      message: `GitHub did not open a confirmation dialog for "${label}".`,
    });
  }

  return value;
}

/**
 * Satisfy a dialog's confirmation and submit it.
 *
 * The phrase to type is read from the dialog itself ("Please type X to
 * confirm") and never assumed, because GitHub words it differently for
 * different operations and owners.
 * @param {Object} session - Browser session
 * @param {Object} options - Confirmation options
 * @param {string} options.label - Label describing the operation
 * @param {Object} options.confirmTarget - Descriptor of the submit button
 * @returns {Promise<void>} Resolves after submitting the dialog
 */
export async function confirmDialog(session, { label, confirmTarget }) {
  const dialog = await readDialog(session.commander, DIALOG_SCOPE);

  if (dialog.inputs > 0) {
    const phrase = confirmationPhrase(dialog.text);

    if (!phrase) {
      await failWithArtifacts(session, {
        label,
        message: `The dialog for "${label}" asks for a typed confirmation but does not state the phrase, so nothing was submitted.`,
      });
    }

    await fillTarget(session, {
      target: SELECTORS.confirmationInput,
      label: `${label} confirmation`,
      value: phrase,
      scopeSelectors: DIALOG_SCOPE,
    });
  }

  await clickTarget(session, {
    target: confirmTarget,
    label: `${label} submit`,
    scopeSelectors: DIALOG_SCOPE,
    waitForNavigation: true,
  });
}

/**
 * Change the visibility of a package.
 * @param {Object} session - Browser session
 * @param {Object} options - Operation options
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {string} options.packageName - Package name
 * @param {string} options.visibility - `public`, `private`, or `internal`
 * @param {Object} options.log - Logger
 * @returns {Promise<{reported: string|null}>} Visibility the page reports afterwards
 */
export async function setPackageVisibility(
  session,
  { owner, packageType, packageName, visibility, log }
) {
  await openPackageSettings(session, { owner, packageType, packageName, log });

  const label = `change ${packageName} to ${visibility}`;
  await openDialog(session, {
    target: SELECTORS.changeVisibilityButton,
    label,
  });

  const selected = await selectVisibilityRadio(session.commander, {
    visibility,
    scopeSelectors: DIALOG_SCOPE,
  });

  if (!selected.selected) {
    await failWithArtifacts(session, {
      label,
      message: `The visibility dialog offers no "${visibility}" option (${selected.reason}).`,
    });
  }

  await confirmDialog(session, {
    label,
    confirmTarget: SELECTORS.confirmVisibilityButton,
  });

  return { reported: await readReportedVisibility(session.commander) };
}

/**
 * Delete a package and all of its versions.
 * @param {Object} session - Browser session
 * @param {Object} options - Operation options
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {string} options.packageName - Package name
 * @param {Object} options.log - Logger
 * @returns {Promise<{submitted: boolean}>} Whether the dialog was submitted
 */
export async function deletePackage(
  session,
  { owner, packageType, packageName, log }
) {
  await openPackageSettings(session, { owner, packageType, packageName, log });

  const label = `delete ${packageName}`;
  await openDialog(session, { target: SELECTORS.deletePackageButton, label });
  await confirmDialog(session, {
    label,
    confirmTarget: SELECTORS.confirmDeleteButton,
  });

  return { submitted: true };
}
