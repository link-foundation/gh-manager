/**
 * Fixtures that imitate the GitHub pages gh-manager drives.
 *
 * They are deliberately not copies of GitHub's markup: the point is to render
 * the same *shape* — a listing that links to packages, a settings page with a
 * danger zone, dialogs that ask for a typed confirmation — so the drivers are
 * tested against the structure they claim to depend on, with no snapshot that
 * stops resembling GitHub the moment it is taken.
 */

import {
  ROLES,
  packageSettingsUrls,
  packageUrl,
  packagesListUrl,
} from '../../src/browser/selectors.js';

const OWNER = { scope: 'orgs', name: 'link-foundation' };
const PACKAGE_TYPE = 'container';

/**
 * Wrap page markup in a signed-in GitHub document.
 * @param {Object} options - Page options
 * @param {string} options.title - Document title
 * @param {string} options.body - Body markup
 * @param {string|null} [options.login] - Signed-in account, or null when signed out
 * @returns {string} Full document
 */
function page({ title, body, login = 'konard' }) {
  const meta = login ? `<meta name="user-login" content="${login}">` : '';
  return `<!doctype html><html><head><title>${title}</title>${meta}</head><body>${body}</body></html>`;
}

/** Markup GitHub serves for a package that does not exist or is not visible. */
export function notFoundPage() {
  return page({ title: 'Page not found · GitHub', body: '<h1>404</h1>' });
}

/**
 * A listing page linking to packages.
 * @param {string[]} names - Package names on this page
 * @returns {string} Full document
 */
export function listingPage(names) {
  const items = names
    .map(
      (name) =>
        `<li><a href="/orgs/link-foundation/packages/container/package/${encodeURIComponent(name)}">${name}</a></li>`
    )
    .join('');

  return page({
    title: 'Packages · link-foundation',
    body: `<nav><a href="/orgs/link-foundation">link-foundation</a></nav><ul>${items}</ul>`,
  });
}

/** Dialog GitHub opens for a visibility change. */
function visibilityDialog(packageName, visibility) {
  const radio = (value) =>
    `<label><input type="radio" name="visibility" value="${value}"${value === visibility ? ' checked' : ''}> ${value}</label>`;

  return `<div role="dialog" id="visibility-dialog">
    <h2>Change package visibility</h2>
    ${radio('public')}${radio('private')}${radio('internal')}
    <p>Please type ${packageName} to confirm.</p>
    <input type="text" name="verify">
    <button type="submit">I understand, change package visibility</button>
  </div>`;
}

/** Dialog GitHub opens for a deletion. */
function deleteDialog(phrase) {
  return `<div role="dialog" id="delete-dialog">
    <h2>Are you sure?</h2>
    <p>Please type ${phrase} to confirm.</p>
    <input type="text" name="verify">
    <button type="submit">I understand the consequences, delete this package</button>
  </div>`;
}

/**
 * Link GitHub renders for a team or a user in an access row.
 * @param {{type: string, name: string}} grantee - Team or user
 * @returns {string} Href
 */
function granteeHref({ type, name }) {
  return type === 'team'
    ? `/orgs/${OWNER.name}/teams/${encodeURIComponent(name)}`
    : `/${encodeURIComponent(name)}`;
}

/**
 * One row of the per-package access list.
 * @param {{type: string, name: string, role: string}} row - Access row
 * @param {boolean} removable - Whether the row offers a remove control
 * @returns {string} Markup
 */
function accessRow(row, removable) {
  const option = (role) =>
    `<option value="${role}"${role === row.role ? ' selected' : ''}>${role}</option>`;

  return `<li>
    <a href="${granteeHref(row)}">${row.name}</a>
    <select>${ROLES.map(option).join('')}</select>
    ${removable ? `<button type="button" data-remove="${row.type}:${row.name}" aria-label="Remove ${row.name}">Remove</button>` : ''}
  </li>`;
}

/**
 * The access section of the settings page.
 * @param {Array<{type: string, name: string, role: string}>} rows - Access rows
 * @param {boolean} removable - Whether the rows offer a remove control
 * @returns {string} Markup
 */
function accessSection(rows, removable) {
  const items = rows.map((row) => accessRow(row, removable)).join('');

  return `<section id="access">
    <h2>Manage access</h2>
    <ul>${items}</ul>
    <button data-testid="invite-button">Invite teams or people</button>
  </section>`;
}

/** Dialog GitHub opens to invite a team or a person. */
function inviteDialog() {
  const role = (name) =>
    `<button type="button" data-role="${name}">${name}</button>`;

  return `<div role="dialog" id="invite-dialog">
    <h2>Invite teams or people</h2>
    <input type="text" name="q">
    <ul id="invite-results"></ul>
    <div id="invite-roles">${ROLES.map(role).join('')}</div>
    <button type="submit">Add</button>
  </div>`;
}

/** Dialog some GitHub layouts open before removing a grantee. */
function removeDialog(name) {
  return `<div role="dialog" id="remove-dialog">
    <h2>Remove ${name}?</h2>
    <button type="submit">Remove</button>
  </div>`;
}

/**
 * The behaviour of the access section: inviting, picking a role, and removing.
 *
 * GitHub's invite flow is a search field whose results appear as you type, so
 * the fixture reacts to typing; it does not render every candidate up front.
 * @param {Object} options - Behaviour options
 * @param {Object} options.state - Mutable package state
 * @param {Array<{type: string, name: string}>} options.directory - Teams and
 *   users GitHub's search can find
 * @param {string} options.removeVia - `inline` removes a row directly,
 *   `dialog` asks for a confirmation first
 * @param {string} options.settingsUrl - Page to return to after a submission
 * @returns {{onFill: Function, onClick: Function}} Page reactions
 */
function createAccessBehaviour({ state, directory, removeVia, settingsUrl }) {
  let picked = null;
  let pickedRole = null;
  let pendingRemoval = null;

  const parse = (value) => {
    const separator = value.indexOf(':');
    return {
      type: value.slice(0, separator),
      name: value.slice(separator + 1),
    };
  };

  const remove = (grantee) => {
    const index = state.access.findIndex(
      (row) =>
        row.type === grantee.type &&
        row.name.toLowerCase() === grantee.name.toLowerCase()
    );

    if (index >= 0) {
      state.access.splice(index, 1);
    }
  };

  const submit = (dialog, apply, navigate) => {
    state.submissions.push({ dialog, typed: picked ? picked.name : '' });
    apply();
    navigate(settingsUrl);
  };

  return {
    /**
     * Fill the search results as the invite field is typed into.
     * @param {Object} element - Field being filled
     * @param {Object} context - Page context
     * @returns {void}
     */
    onFill(element, { document }) {
      const results = document.getElementById('invite-results');

      if (!results) {
        return;
      }

      const query = String(element.value ?? '').toLowerCase();
      results.innerHTML = directory
        .filter((entry) => entry.name.toLowerCase().includes(query))
        .map(
          (entry) =>
            `<li><button type="button" data-pick="${entry.type}:${entry.name}">${entry.name}</button></li>`
        )
        .join('');
    },

    /**
     * React to a click in the access section or one of its dialogs.
     * @param {Object} element - Clicked element
     * @param {Object} context - Page context
     * @returns {boolean} True when the click belonged to the access section
     */
    onClick(element, { document, navigate }) {
      const dialogs = document.getElementById('dialogs');
      const attribute = (name) => element.getAttribute(name);

      if (attribute('data-testid') === 'invite-button') {
        picked = null;
        pickedRole = null;
        dialogs.innerHTML = inviteDialog();
        return true;
      }

      if (attribute('data-pick')) {
        picked = parse(attribute('data-pick'));
        return true;
      }

      if (attribute('data-role')) {
        pickedRole = attribute('data-role');
        return true;
      }

      if (attribute('data-remove')) {
        pendingRemoval = parse(attribute('data-remove'));

        if (removeVia === 'dialog') {
          dialogs.innerHTML = removeDialog(pendingRemoval.name);
          return true;
        }

        submit('remove-inline', () => remove(pendingRemoval), navigate);
        return true;
      }

      if (element.closest('#invite-dialog')) {
        submit(
          'invite-dialog',
          () => {
            if (picked && pickedRole) {
              remove(picked);
              state.access.push({ ...picked, role: pickedRole });
            }
          },
          navigate
        );
        return true;
      }

      if (element.closest('#remove-dialog')) {
        submit('remove-dialog', () => remove(pendingRemoval), navigate);
        return true;
      }

      return false;
    },
  };
}

/**
 * Build the pages of one package, backed by mutable state.
 *
 * The state is what a real GitHub would hold: the package's visibility, and
 * whether it still exists. Submitting a dialog changes it, so a test can act
 * through the driver and then assert on the state that resulted.
 * @param {Object} options - Package options
 * @param {string} options.packageName - Package name
 * @param {string} [options.visibility] - Starting visibility
 * @param {string} [options.settingsVia] - `url` serves the direct settings URL,
 *   `link` serves the settings page only where the package page links to it,
 *   and `nowhere` makes that link lead to a page that is not the settings page
 * @param {string} [options.dialogPhrase] - Phrase the delete dialog asks for,
 *   which the fixture rejects when it is not the package name
 * @param {Array<{type: string, name: string, role: string}>} [options.access] -
 *   Teams and users that already have access
 * @param {Array<{type: string, name: string}>} [options.directory] - Teams and
 *   users GitHub's invite search can find
 * @param {string} [options.removeVia] - `inline` removes a row directly,
 *   `dialog` asks for a confirmation first, and `nowhere` renders rows that
 *   carry no remove control at all
 * @returns {{state: Object, routes: Object, settingsUrl: string, coordinates: Object}} State and routes
 */
export function packagePages({
  packageName,
  visibility = 'private',
  settingsVia = 'url',
  dialogPhrase = packageName,
  access = [],
  directory = [],
  removeVia = 'inline',
}) {
  const coordinates = { owner: OWNER, packageType: PACKAGE_TYPE, packageName };
  const state = {
    visibility,
    deleted: false,
    submissions: [],
    access: [...access],
  };
  const settingsUrl =
    settingsVia === 'url'
      ? packageSettingsUrls(coordinates)[0]
      : `${packageUrl(coordinates)}?tab=settings`;
  const showsAccess = access.length > 0 || directory.length > 0;
  const behaviour = createAccessBehaviour({
    state,
    directory,
    removeVia,
    settingsUrl,
  });

  /**
   * Render the settings page for the current state.
   * @returns {string} Full document
   */
  const settingsPage = () =>
    state.deleted
      ? notFoundPage()
      : page({
          title: `${packageName} · Package settings`,
          body: `<h1>${packageName}</h1>
            <p>This package is currently ${state.visibility}.</p>
            <div id="danger-zone">
              <button id="change-visibility">Change visibility</button>
              <button id="delete-package">Delete this package</button>
            </div>
            ${showsAccess ? accessSection(state.access, removeVia !== 'nowhere') : ''}
            <div id="dialogs"></div>`,
        });

  /**
   * React to a click on the settings page.
   * @param {Object} element - Clicked element
   * @param {Object} context - Page context
   * @returns {void}
   */
  const onSettingsClick = (element, context) => {
    if (showsAccess && behaviour.onClick(element, context)) {
      return;
    }

    const { document, navigate } = context;
    const dialogs = document.getElementById('dialogs');

    if (element.id === 'change-visibility') {
      dialogs.innerHTML = visibilityDialog(packageName, state.visibility);
      return;
    }

    if (element.id === 'delete-package') {
      dialogs.innerHTML = deleteDialog(dialogPhrase);
      return;
    }

    if (element.getAttribute('type') !== 'submit') {
      return;
    }

    const typed = document.querySelector('input[name="verify"]')?.value ?? '';
    state.submissions.push({
      dialog: element.closest('[role="dialog"]').id,
      typed,
    });

    if (typed !== packageName) {
      return;
    }

    if (element.closest('#delete-dialog')) {
      state.deleted = true;
      navigate(packageUrl(coordinates));
      return;
    }

    const chosen = document.querySelector(
      'input[type="radio"][name="visibility"][checked]'
    );
    state.visibility = chosen ? chosen.getAttribute('value') : state.visibility;
    navigate(settingsUrl);
  };

  const routes = {
    [packageUrl(coordinates)]: {
      html: () =>
        state.deleted
          ? notFoundPage()
          : page({
              title: `Package ${packageName}`,
              body: `<h1>${packageName}</h1><a href="${settingsUrl}">Package settings</a>`,
            }),
      onClick: (element, context) => {
        if (element.tagName === 'A') {
          context.navigate(settingsUrl);
        }
      },
    },
  };

  routes[settingsUrl] =
    settingsVia === 'nowhere'
      ? page({
          title: `${packageName}`,
          body: '<h1>Not the settings page</h1>',
        })
      : {
          html: settingsPage,
          onClick: onSettingsClick,
          onFill: behaviour.onFill,
        };

  return { state, routes, settingsUrl, coordinates };
}

/**
 * Routes for an owner's listing pages.
 *
 * GitHub answers a page number past the end by serving the last page again in
 * place of an empty one, so the fixture does the same: that is exactly the
 * behaviour the enumeration has to terminate on.
 * @param {string[][]} pages - Package names per listing page
 * @returns {Object} Routes keyed by URL
 */
export function listingRoutes(pages) {
  const routes = {};
  const url = (page) =>
    packagesListUrl({ owner: OWNER, packageType: PACKAGE_TYPE, page });

  pages.forEach((names, index) => {
    routes[url(index + 1)] = listingPage(names);
  });

  routes[url(pages.length + 1)] = listingPage(pages[pages.length - 1] ?? []);
  return routes;
}

export { OWNER, PACKAGE_TYPE };
