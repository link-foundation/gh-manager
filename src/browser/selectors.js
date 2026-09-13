/**
 * Every GitHub URL, CSS selector, and button label the tool depends on.
 *
 * GitHub changes its UI without notice, so all of that knowledge lives in this
 * one module. When a run fails with "no element matched", this file is the only
 * place that needs updating, and the failure artifacts in `<app-dir>/logs/`
 * show what the page actually looked like.
 */

const GITHUB_ORIGIN = 'https://github.com';

/**
 * Home page, which shows the signed-in account.
 * @returns {string} URL
 */
export function homeUrl() {
  return `${GITHUB_ORIGIN}/`;
}

/**
 * Sign-in page.
 * @returns {string} URL
 */
export function loginUrl() {
  return `${GITHUB_ORIGIN}/login`;
}

/**
 * Page listing the packages of an owner.
 * @param {Object} options - Listing options
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {number} [options.page] - 1-based page number
 * @returns {string} URL
 */
export function packagesListUrl({ owner, packageType, page = 1 }) {
  const name = encodeURIComponent(owner.name);
  const query = `ecosystem=${encodeURIComponent(packageType)}&page=${page}`;

  if (owner.scope === 'orgs') {
    return `${GITHUB_ORIGIN}/orgs/${name}/packages?${query}`;
  }

  return `${GITHUB_ORIGIN}/${name}?tab=packages&${query}`;
}

/**
 * Page of a single package.
 * @param {Object} options - Package coordinates
 * @param {{scope: string, name: string}} options.owner - Package owner
 * @param {string} options.packageType - GitHub package ecosystem
 * @param {string} options.packageName - Package name
 * @returns {string} URL
 */
export function packageUrl({ owner, packageType, packageName }) {
  const parts = [
    owner.scope,
    encodeURIComponent(owner.name),
    'packages',
    encodeURIComponent(packageType),
    'package',
    encodeURIComponent(packageName),
  ];
  return `${GITHUB_ORIGIN}/${parts.join('/')}`;
}

/**
 * Candidate settings URLs for a package.
 *
 * The package page normally links to its own settings, which is what the tool
 * follows first; these are the fallbacks when that link is missing.
 * @param {Object} options - Package coordinates (see packageUrl)
 * @returns {string[]} URLs to try in order
 */
export function packageSettingsUrls(options) {
  const { owner, packageType, packageName } = options;
  const prefix = `${GITHUB_ORIGIN}/${owner.scope}/${encodeURIComponent(owner.name)}/packages/${encodeURIComponent(packageType)}`;
  return [
    `${prefix}/${encodeURIComponent(packageName)}/settings`,
    `${packageUrl(options)}/settings`,
  ];
}

/** Selectors and labels used to drive the package settings page. */
export const SELECTORS = {
  /** Link from a package page to its settings page. */
  settingsLink: {
    selectors: [
      'a[href$="/settings"][href*="/packages/"]',
      'a[data-testid="package-settings-link"]',
    ],
    texts: ['package settings', 'settings'],
  },

  /**
   * Button that opens the "Change visibility" dialog.
   *
   * Matched by its wording first: the danger zone buttons are plain summaries
   * or buttons with no distinguishing class, so any CSS selector broad enough
   * to catch them also catches unrelated page chrome.
   */
  changeVisibilityButton: {
    selectors: ['button[data-testid="change-visibility-button"]'],
    texts: ['change visibility', 'change package visibility'],
    preferText: true,
  },

  /** Button that opens the "Delete this package" dialog. */
  deletePackageButton: {
    selectors: ['button[data-testid="delete-package-button"]'],
    texts: ['delete this package', 'delete package'],
    preferText: true,
  },

  /** Container of an opened confirmation dialog. */
  openDialog: {
    selectors: [
      'details-dialog[open]',
      'details[open] details-dialog',
      'dialog[open]',
      'modal-dialog[open]',
      '[role="dialog"]',
    ],
    texts: [],
  },

  /** Submit button inside the visibility dialog. */
  confirmVisibilityButton: {
    selectors: ['button[type="submit"]', 'input[type="submit"]'],
    texts: ['change package visibility', 'change visibility', 'i understand'],
    preferText: true,
  },

  /** Submit button inside the delete dialog. */
  confirmDeleteButton: {
    selectors: ['button[type="submit"]', 'input[type="submit"]'],
    texts: ['delete this package', 'delete package', 'i understand'],
    preferText: true,
  },

  /** Free-text confirmation input inside a dialog. */
  confirmationInput: {
    selectors: [
      'input[name="verify"]',
      'input[type="text"]:not([type="hidden"])',
      'input:not([type])',
    ],
    texts: [],
  },

  /** Button that opens the "Invite teams or people" flow. */
  inviteButton: {
    selectors: ['button[data-testid="invite-button"]'],
    texts: ['invite teams or people', 'add teams or people', 'invite'],
    preferText: true,
  },

  /** Search field of the invite flow. */
  inviteInput: {
    selectors: [
      'input[name="q"]',
      'input[type="search"]',
      'input[type="text"]',
    ],
    texts: [],
  },

  /** Confirm button of the invite flow. */
  inviteConfirmButton: {
    selectors: ['button[type="submit"]'],
    texts: ['add', 'invite', 'save'],
    preferText: true,
  },
};

/**
 * Page holding a repository's "Code security and analysis" settings.
 *
 * Several of the toggles on it exist nowhere else: the dependency graph has
 * no REST endpoint, no GraphQL mutation, and no `gh` command, so this page is
 * the only way to flip it.
 * @param {{owner: string, name: string}} repo - Repository descriptor
 * @returns {string} URL
 */
export function repoSecuritySettingsUrl(repo) {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.name);
  return `${GITHUB_ORIGIN}/${owner}/${name}/settings/security_analysis`;
}

/**
 * Wording of the buttons that flip one security feature.
 *
 * Matched as whole labels, never as substrings, and never when the label
 * mentions "all": a page that offers "Enable all" alongside the per-feature
 * buttons must not have that one clicked by a command naming one feature.
 */
export const SECURITY_CONTROLS = {
  enable: ['enable'],
  disable: ['disable'],
};

/**
 * Phrases that mean a toggle is not this account's to flip.
 *
 * An organization or enterprise policy leaves the control on the page but
 * inert, so clicking it would look like success and change nothing.
 */
export const SECURITY_LOCK_PHRASES = [
  'enforced by',
  'managed by a security configuration',
  'managed by your organization',
  'managed by the organization',
  'managed by your enterprise',
  'contact your organization owner',
  'contact an organization owner',
];

/** Attribute used to hand a matched element to the click helpers. */
export const MARK_ATTRIBUTE = 'data-gh-manager-target';

/** Visibility values GitHub accepts for a package. */
export const VISIBILITIES = ['public', 'private', 'internal'];

/** Roles GitHub offers for per-package access. */
export const ROLES = ['read', 'write', 'admin'];
