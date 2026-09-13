/**
 * Fixtures that imitate a repository's "Code security and analysis" page.
 *
 * The page is rendered the way GitHub renders it — a heading naming a feature,
 * a description, and a button on the right whose label is the action, not the
 * state — because that shape is exactly what the driver claims to depend on: a
 * heading to find the feature by, and an "Enable" or "Disable" button in the
 * nearest container around it.
 */

import { repoSecuritySettingsUrl } from '../../src/browser/selectors.js';
import { SECURITY_FEATURES } from '../../src/security/features.js';

const REPO = { owner: 'link-foundation', name: 'gh-manager' };

/**
 * Wrap page markup in a signed-in GitHub document.
 * @param {Object} options - Page options
 * @param {string} options.body - Body markup
 * @param {string|null} [options.login] - Signed-in account
 * @returns {string} Full document
 */
function page({ body, login = 'konard' }) {
  const meta = login ? `<meta name="user-login" content="${login}">` : '';
  return `<!doctype html><html><head><title>Code security and analysis</title>${meta}</head><body>${body}</body></html>`;
}

/**
 * The control of one feature row.
 * @param {Object} options - Control options
 * @param {string} options.id - Feature id
 * @param {string} options.state - `enabled` or `disabled`
 * @param {boolean} options.locked - Whether a policy owns the toggle
 * @returns {string} Markup
 */
function control({ id, state, locked }) {
  const action = state === 'enabled' ? 'disable' : 'enable';
  const label = action === 'enable' ? 'Enable' : 'Disable';
  const note = locked
    ? '<span class="note">Enforced by your organization</span>'
    : '';

  return `${note}<button type="button" data-feature="${id}" data-action="${action}"${locked ? ' disabled' : ''}>${label}</button>`;
}

/**
 * One feature row.
 * @param {Object} options - Row options
 * @param {Object} options.feature - Feature definition
 * @param {string} options.state - `enabled` or `disabled`
 * @param {boolean} options.locked - Whether a policy owns the toggle
 * @param {boolean} options.controllable - Whether the row carries a button
 * @returns {string} Markup
 */
function featureRow({ feature, state, locked, controllable }) {
  return `<div class="Box-row" id="row-${feature.id}">
    <div class="description">
      <h3>${feature.label}</h3>
      <p>${feature.summary}</p>
    </div>
    <div class="actions">${controllable ? control({ id: feature.id, state, locked }) : '<span>Enabled for all repositories in the organization</span>'}</div>
  </div>`;
}

/**
 * A row that names two features and carries a single button.
 *
 * GitHub has grouped these toggles differently over time, and a grouped row is
 * the case where clicking "the" button could flip a feature nobody named, so
 * the driver has to refuse it.
 * @param {Object} options - Row options
 * @param {Object[]} options.features - Features named by the row
 * @returns {string} Markup
 */
function groupedRow({ features }) {
  const headings = features
    .map((feature) => `<h3>${feature.label}</h3>`)
    .join('');

  return `<div class="Box-row" id="row-grouped">
    <div class="description">${headings}</div>
    <div class="actions"><button type="button" data-feature="grouped" data-action="enable">Enable</button></div>
  </div>`;
}

/**
 * Build the security settings page of a repository, backed by mutable state.
 * @param {Object} [options] - Page options
 * @param {Object<string, string>} [options.states] - Starting state per feature id
 * @param {string[]} [options.locked] - Features an organization policy owns
 * @param {string[]} [options.uncontrollable] - Features rendered without a button
 * @param {string[]} [options.grouped] - Features rendered in one shared row
 * @param {boolean} [options.enableAll] - Render the page-wide "Enable all" button
 * @param {boolean} [options.admin] - Render the toggles at all
 * @param {string|null} [options.login] - Signed-in account
 * @param {{owner: string, name: string}} [options.repo] - Repository
 * @returns {{state: Object, routes: Object, url: string, repo: Object}} State and routes
 */
export function securityPages({
  states = {},
  locked = [],
  uncontrollable = [],
  grouped = [],
  enableAll = false,
  admin = true,
  login = 'konard',
  repo = REPO,
} = {}) {
  const url = repoSecuritySettingsUrl(repo);
  const state = {
    features: Object.fromEntries(
      SECURITY_FEATURES.map((feature) => [
        feature.id,
        states[feature.id] ?? 'disabled',
      ])
    ),
    clicks: [],
  };

  /**
   * Render the page for the current state.
   * @returns {string} Full document
   */
  const html = () => {
    if (!admin) {
      return page({
        body: '<h1>gh-manager</h1><p>You do not have admin rights on this repository.</p>',
        login,
      });
    }

    const rows = SECURITY_FEATURES.filter(
      (feature) => !grouped.includes(feature.id)
    )
      .map((feature) =>
        featureRow({
          feature,
          state: state.features[feature.id],
          locked: locked.includes(feature.id),
          controllable: !uncontrollable.includes(feature.id),
        })
      )
      .join('');

    const group =
      grouped.length > 0
        ? groupedRow({
            features: SECURITY_FEATURES.filter((feature) =>
              grouped.includes(feature.id)
            ),
          })
        : '';

    return page({
      body: `<h1>Code security and analysis</h1>
        ${enableAll ? '<div class="Box-header"><button type="button" id="enable-all">Enable all</button></div>' : ''}
        <div class="Box">${group}${rows}</div>`,
      login,
    });
  };

  return {
    state,
    url,
    repo,
    routes: {
      [url]: {
        html,
        /**
         * Flip the feature whose button was clicked.
         * @param {Object} element - Clicked element
         * @param {Object} context - Page context
         * @returns {void}
         */
        onClick(element, { navigate }) {
          const feature = element.getAttribute('data-feature');
          const action = element.getAttribute('data-action');

          state.clicks.push({
            feature: feature ?? element.getAttribute('id'),
            action,
          });

          if (!feature || element.hasAttribute('disabled')) {
            return;
          }

          state.features[feature] =
            action === 'enable' ? 'enabled' : 'disabled';
          navigate(url);
        },
      },
    },
  };
}

export { REPO };
