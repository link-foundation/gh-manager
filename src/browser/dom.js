/**
 * DOM helpers shared by the page drivers.
 *
 * Every helper runs a single self-contained function in the page with one
 * serializable argument, which keeps the code engine neutral (Playwright and
 * Puppeteer behave identically) and avoids constructing functions inside the
 * page, which GitHub's content security policy forbids.
 */

import { MARK_ATTRIBUTE, SELECTORS } from './selectors.js';

/** One selector matching any container GitHub uses for a dialog. */
const DIALOG_SELECTOR = SELECTORS.openDialog.selectors.join(', ');

/**
 * Mark the first element matching a target descriptor.
 *
 * CSS selectors are tried first, then visible clickable elements whose text
 * contains one of the descriptor's labels; a descriptor with `preferText` set
 * reverses that order, which is what buttons inside a dialog need because their
 * wording identifies them far better than a generic `button[type="submit"]`.
 * The match is tagged with a data attribute so it can be clicked or filled with
 * an ordinary CSS selector.
 * @param {Object} commander - browser-commander instance
 * @param {Object} options - Marking options
 * @param {{selectors: string[], texts: string[], preferText?: boolean}} options.target - Target descriptor
 * @param {string[]} [options.scopeSelectors] - Restrict the search to these containers
 * @returns {Promise<{found: boolean, matchedBy?: string, text?: string, reason?: string}>} Result
 */
export function markTarget(commander, { target, scopeSelectors = [] }) {
  return commander.evaluate({
    fn: ({ attribute, selectors, texts, scopes, preferText }) => {
      for (const marked of document.querySelectorAll(`[${attribute}]`)) {
        marked.removeAttribute(attribute);
      }

      const roots = [];

      if (scopes.length > 0) {
        for (const scope of scopes) {
          roots.push(...document.querySelectorAll(scope));
        }

        if (roots.length === 0) {
          return { found: false, reason: 'no-container' };
        }
      } else {
        roots.push(document);
      }

      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
      };

      const describe = (element) =>
        (element.innerText || element.value || '').trim().slice(0, 120);

      const mark = (element, matchedBy) => {
        element.setAttribute(attribute, '1');
        return { found: true, matchedBy, text: describe(element) };
      };

      const bySelector = () => {
        for (const root of roots) {
          for (const selector of selectors) {
            for (const element of root.querySelectorAll(selector)) {
              if (isVisible(element)) {
                return mark(element, `selector:${selector}`);
              }
            }
          }
        }

        return null;
      };

      const clickable =
        'button, a, summary, [role="button"], [role="menuitem"], input[type="submit"]';

      const byText = () => {
        for (const root of roots) {
          for (const element of root.querySelectorAll(clickable)) {
            if (!isVisible(element)) {
              continue;
            }

            const label = [
              element.innerText || '',
              element.getAttribute('aria-label') || '',
              element.value || '',
            ]
              .join(' ')
              .toLowerCase();

            for (const text of texts) {
              if (label.includes(text)) {
                return mark(element, `text:${text}`);
              }
            }
          }
        }

        return null;
      };

      const passes = preferText ? [byText, bySelector] : [bySelector, byText];

      for (const pass of passes) {
        const result = pass();

        if (result) {
          return result;
        }
      }

      return { found: false, reason: 'no-match' };
    },
    args: [
      {
        attribute: MARK_ATTRIBUTE,
        selectors: target.selectors ?? [],
        texts: target.texts ?? [],
        scopes: scopeSelectors,
        preferText: Boolean(target.preferText),
      },
    ],
  });
}

/** CSS selector of the element most recently marked by markTarget. */
export const MARKED_SELECTOR = `[${MARK_ATTRIBUTE}]`;

/**
 * Read the login of the signed-in account, if any.
 *
 * GitHub renders `<meta name="user-login">` on every page while signed in,
 * which is a far more stable signal than any part of the visible layout.
 * @param {Object} commander - browser-commander instance
 * @returns {Promise<string|null>} Login, or null when signed out
 */
export function readSignedInLogin(commander) {
  return commander.evaluate({
    fn: () => {
      const meta = document.querySelector('meta[name="user-login"]');
      const login = meta ? meta.getAttribute('content') : '';
      return login && login.length > 0 ? login : null;
    },
  });
}

/**
 * Read the coarse state of the page that is currently open.
 *
 * `notFound` covers both a missing package and a package that is invisible to
 * the signed-in account, which GitHub renders identically.
 * @param {Object} commander - browser-commander instance
 * @returns {Promise<{title: string, login: string|null, notFound: boolean}>} State
 */
export function readPageState(commander) {
  return commander.evaluate({
    fn: () => {
      const meta = document.querySelector('meta[name="user-login"]');
      const login = meta ? meta.getAttribute('content') : '';
      const title = document.title || '';
      return {
        title,
        login: login && login.length > 0 ? login : null,
        notFound: /page not found|404/i.test(title),
      };
    },
  });
}

/**
 * Collect the package names linked from the current listing page.
 * @param {Object} commander - browser-commander instance
 * @param {Object} options - Collection options
 * @param {string} options.packageType - GitHub package ecosystem
 * @returns {Promise<string[]>} Package names found on the page
 */
export function collectPackageNames(commander, { packageType }) {
  return commander.evaluate({
    fn: ({ ecosystem }) => {
      const pattern = new RegExp(
        `/packages/${ecosystem}/package/([^/?#]+)`,
        'i'
      );
      const names = new Set();

      for (const anchor of document.querySelectorAll('a[href]')) {
        const match = anchor.getAttribute('href').match(pattern);

        if (match) {
          names.add(decodeURIComponent(match[1]));
        }
      }

      return [...names];
    },
    args: [{ ecosystem: packageType }],
  });
}

/**
 * Read the visibility GitHub currently reports for the open package page.
 * @param {Object} commander - browser-commander instance
 * @returns {Promise<string|null>} Visibility, or null when it cannot be read
 */
export function readReportedVisibility(commander) {
  return commander.evaluate({
    fn: ({ dialogSelector }) => {
      const text = document.body ? document.body.innerText : '';
      const currently = text.match(/currently\s+(public|private|internal)/i);

      if (currently) {
        return currently[1].toLowerCase();
      }

      // Only a radio on the page itself counts. A radio inside a dialog that
      // is still open is the choice that was *made*, not the visibility that
      // resulted, and reading it would report a failed change as a success.
      for (const checked of document.querySelectorAll(
        'input[type="radio"][name*="visibility" i]:checked'
      )) {
        if (!checked.closest(dialogSelector)) {
          return String(checked.value).toLowerCase();
        }
      }

      return null;
    },
    args: [{ dialogSelector: DIALOG_SELECTOR }],
  });
}

/**
 * Read the text and inputs of the dialog that is currently open.
 * @param {Object} commander - browser-commander instance
 * @param {string[]} scopeSelectors - Selectors that identify an open dialog
 * @returns {Promise<{open: boolean, text: string, inputs: number}>} Dialog state
 */
export function readDialog(commander, scopeSelectors) {
  return commander.evaluate({
    fn: ({ scopes }) => {
      for (const scope of scopes) {
        for (const element of document.querySelectorAll(scope)) {
          const rect = element.getBoundingClientRect();

          if (rect.width > 0 || rect.height > 0) {
            return {
              open: true,
              text: (element.innerText || '').trim(),
              inputs: element.querySelectorAll(
                'input[type="text"], input:not([type]), input[name="verify"]'
              ).length,
            };
          }
        }
      }

      return { open: false, text: '', inputs: 0 };
    },
    args: [{ scopes: scopeSelectors }],
  });
}

/**
 * Select a visibility radio button inside the open dialog.
 * @param {Object} commander - browser-commander instance
 * @param {Object} options - Selection options
 * @param {string} options.visibility - `public`, `private`, or `internal`
 * @param {string[]} options.scopeSelectors - Selectors that identify an open dialog
 * @returns {Promise<{selected: boolean, reason?: string}>} Result
 */
export function selectVisibilityRadio(
  commander,
  { visibility, scopeSelectors }
) {
  return commander.evaluate({
    fn: ({ value, scopes }) => {
      const containers = [];

      for (const scope of scopes) {
        containers.push(...document.querySelectorAll(scope));
      }

      if (containers.length === 0) {
        containers.push(document.body);
      }

      for (const container of containers) {
        const radios = container.querySelectorAll('input[type="radio"]');

        for (const radio of radios) {
          const label = radio.closest('label');
          const described = [
            radio.value || '',
            radio.getAttribute('aria-label') || '',
            label ? label.innerText || '' : '',
          ]
            .join(' ')
            .toLowerCase();

          if (described.includes(value)) {
            radio.click();
            return {
              selected: radio.checked,
              reason: radio.checked ? undefined : 'click-ignored',
            };
          }
        }
      }

      return { selected: false, reason: 'no-radio' };
    },
    args: [{ value: visibility, scopes: scopeSelectors }],
  });
}

/**
 * Read the per-package access rows of the settings page.
 *
 * A row is anything that names a team or a user and carries a role control.
 * @param {Object} commander - browser-commander instance
 * @param {Object} options - Reading options
 * @param {string[]} options.roles - Role names to recognize
 * @returns {Promise<Array<{type: string, name: string, role: string|null}>>} Access rows
 */
export function readAccessRows(commander, { roles }) {
  return commander.evaluate({
    fn: ({ knownRoles }) => {
      const rows = [];
      const seen = new Set();
      const candidates = document.querySelectorAll(
        'li, tr, [role="listitem"], [role="row"]'
      );

      for (const candidate of candidates) {
        const anchor = candidate.querySelector('a[href]');

        if (!anchor) {
          continue;
        }

        const href = anchor.getAttribute('href') || '';
        const teamMatch = href.match(/\/orgs\/[^/]+\/teams\/([^/?#]+)/i);
        const userMatch = href.match(/^\/([^/?#]+)$/);

        if (!teamMatch && !userMatch) {
          continue;
        }

        const select = candidate.querySelector('select');
        // `selected` is the live property, so it still reports the truth after
        // the operator has changed the selection; the attribute would not.
        const chosen = select
          ? [...select.options].find((option) => option.selected)
          : null;
        const controlText = (
          select ? chosen?.textContent || '' : candidate.innerText || ''
        ).toLowerCase();

        const role = knownRoles.find((name) => controlText.includes(name));

        if (!role) {
          continue;
        }

        const entry = {
          type: teamMatch ? 'team' : 'user',
          name: decodeURIComponent(teamMatch ? teamMatch[1] : userMatch[1]),
          role,
        };
        const key = `${entry.type}:${entry.name}`;

        if (!seen.has(key)) {
          seen.add(key);
          rows.push(entry);
        }
      }

      return rows;
    },
    args: [{ knownRoles: roles }],
  });
}

/**
 * Mark a control that belongs to one team's or user's access row.
 *
 * The grantee is identified by the link GitHub renders in its row, which is the
 * only part of that row guaranteed to name it unambiguously.
 * @param {Object} commander - browser-commander instance
 * @param {Object} options - Marking options
 * @param {{type: string, name: string}} options.grantee - Team or user to find
 * @param {string[]} options.labels - Lowercase labels of the control to mark
 * @returns {Promise<{found: boolean, matchedBy?: string, text?: string, reason?: string}>} Result
 */
export function markAccessRowControl(commander, { grantee, labels }) {
  return commander.evaluate({
    fn: ({ attribute, type, namePattern, controlLabels }) => {
      for (const marked of document.querySelectorAll(`[${attribute}]`)) {
        marked.removeAttribute(attribute);
      }

      const matchesGrantee = (href) => {
        const expression =
          type === 'team'
            ? new RegExp(`/teams/${namePattern}(?:[/?#]|$)`, 'i')
            : new RegExp(`^/${namePattern}(?:[/?#]|$)`, 'i');
        return expression.test(href);
      };

      const controls =
        'button, a, summary, [role="button"], [role="menuitem"], select';
      const rows = document.querySelectorAll(
        'li, tr, [role="listitem"], [role="row"]'
      );

      for (const row of rows) {
        const anchors = [...row.querySelectorAll('a[href]')];

        if (
          !anchors.some((a) => matchesGrantee(a.getAttribute('href') || ''))
        ) {
          continue;
        }

        for (const control of row.querySelectorAll(controls)) {
          const label = [
            control.innerText || '',
            control.getAttribute('aria-label') || '',
          ]
            .join(' ')
            .toLowerCase();

          if (controlLabels.some((wanted) => label.includes(wanted))) {
            control.setAttribute(attribute, '1');
            return {
              found: true,
              matchedBy: 'row-control',
              text: (control.innerText || '').trim().slice(0, 120),
            };
          }
        }

        return { found: false, reason: 'row-without-control' };
      }

      return { found: false, reason: 'no-row' };
    },
    args: [
      {
        attribute: MARK_ATTRIBUTE,
        type: grantee.type,
        namePattern: grantee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        controlLabels: labels,
      },
    ],
  });
}

/**
 * Extract the phrase a confirmation dialog asks the operator to type.
 *
 * GitHub words these prompts as "Please type <package> to confirm", so the
 * literal is read from the dialog itself and never guessed.
 * @param {string} dialogText - Visible text of the dialog
 * @returns {string|null} Phrase to type, or null when the prompt is absent
 */
export function confirmationPhrase(dialogText) {
  const match = String(dialogText ?? '').match(
    /type\s+([^\n]+?)\s+to\s+confirm/i
  );

  if (!match) {
    return null;
  }

  return match[1].replace(/^["'`]+|["'`:.]+$/g, '').trim() || null;
}
