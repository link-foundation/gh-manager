/**
 * The page functions that read and mark GitHub's DOM.
 *
 * These run against a real DOM implementation through the fake session in
 * `tests/fixtures/fake-browser.js`, so the shipped selectors and text matching
 * are what is being tested, not a re-implementation of them.
 */

import { describe, it, expect } from 'test-anywhere';

import {
  MARKED_SELECTOR,
  collectPackageNames,
  confirmationPhrase,
  markAccessRowControl,
  markTarget,
  readAccessRows,
  readDialog,
  readPageState,
  readReportedVisibility,
  readSignedInLogin,
  selectVisibilityRadio,
} from '../src/browser/dom.js';
import { ROLES, SELECTORS } from '../src/browser/selectors.js';
import { createFakeSession } from './fixtures/fake-browser.js';

/**
 * Open a page in a fake session and return its commander.
 * @param {string} body - Body markup
 * @param {Object} [options] - Page options
 * @param {string} [options.title] - Document title
 * @param {string|null} [options.login] - Signed-in account
 * @returns {Object} browser-commander stand-in
 */
function commanderFor(body, { title = 'GitHub', login = 'konard' } = {}) {
  const meta = login ? `<meta name="user-login" content="${login}">` : '';
  const html = `<!doctype html><html><head><title>${title}</title>${meta}</head><body>${body}</body></html>`;
  const url = 'https://github.com/test';

  return createFakeSession({ routes: { [url]: html }, start: url }).commander;
}

describe('readPageState', () => {
  it('reads the signed-in login from the meta tag GitHub always renders', async () => {
    const commander = commanderFor('<h1>hi</h1>');

    expect(await readSignedInLogin(commander)).toBe('konard');
    expect(await readPageState(commander)).toEqual({
      title: 'GitHub',
      login: 'konard',
      notFound: false,
    });
  });

  it('reports a signed-out page as having no login', async () => {
    expect(
      await readSignedInLogin(commanderFor('<h1>hi</h1>', { login: null }))
    ).toBe(null);
  });

  it('recognizes GitHub’s "page not found" title', async () => {
    const state = await readPageState(
      commanderFor('<h1>404</h1>', { title: 'Page not found · GitHub' })
    );

    expect(state.notFound).toBe(true);
  });
});

describe('collectPackageNames', () => {
  it('collects each package linked from a listing page once', async () => {
    const commander = commanderFor(`
      <a href="/orgs/link-foundation/packages/container/package/box">box</a>
      <a href="/orgs/link-foundation/packages/container/package/box">box again</a>
      <a href="/orgs/link-foundation/packages/container/package/box-dind">box-dind</a>
      <a href="/orgs/link-foundation/packages/npm/package/gh-manager">an npm package</a>
      <a href="/link-foundation/box">the repository</a>
    `);

    expect(
      await collectPackageNames(commander, { packageType: 'container' })
    ).toEqual(['box', 'box-dind']);
  });

  it('decodes names that are escaped in the href', async () => {
    const commander = commanderFor(
      '<a href="/orgs/o/packages/container/package/box%2Fnested">box/nested</a>'
    );

    expect(
      await collectPackageNames(commander, { packageType: 'container' })
    ).toEqual(['box/nested']);
  });
});

describe('markTarget', () => {
  it('prefers a CSS selector over matching text', async () => {
    const commander = commanderFor(`
      <button data-testid="change-visibility-button">Chg</button>
      <button>Change visibility</button>
    `);

    const match = await markTarget(commander, {
      target: {
        selectors: ['button[data-testid="change-visibility-button"]'],
        texts: ['change visibility'],
      },
    });

    expect(match.found).toBe(true);
    expect(match.matchedBy).toBe(
      'selector:button[data-testid="change-visibility-button"]'
    );
  });

  it('prefers the wording when the descriptor says so', async () => {
    const commander = commanderFor(`
      <button type="submit">Cancel</button>
      <button type="submit">I understand, change package visibility</button>
    `);

    const match = await markTarget(commander, {
      target: SELECTORS.confirmVisibilityButton,
    });

    expect(match.matchedBy).toBe('text:change package visibility');
    expect(match.text).toBe('I understand, change package visibility');
  });

  it('skips elements that are not rendered', async () => {
    const commander = commanderFor(`
      <button hidden>Change visibility</button>
      <button>Change visibility</button>
      <span id="second">second</span>
    `);

    await markTarget(commander, {
      target: { selectors: [], texts: ['change visibility'] },
    });

    const marked = await commander.evaluate({
      fn: ({ selector }) =>
        document.querySelector(selector).hasAttribute('hidden'),
      args: [{ selector: MARKED_SELECTOR }],
    });

    expect(marked).toBe(false);
  });

  it('marks only one element at a time', async () => {
    const commander = commanderFor('<button>one</button><button>two</button>');

    await markTarget(commander, { target: { selectors: [], texts: ['one'] } });
    await markTarget(commander, { target: { selectors: [], texts: ['two'] } });

    const marks = await commander.evaluate({
      fn: ({ selector }) =>
        [...document.querySelectorAll(selector)].map(
          (element) => element.innerText
        ),
      args: [{ selector: MARKED_SELECTOR }],
    });

    expect(marks).toEqual(['two']);
  });

  it('refuses to match outside the container it was given', async () => {
    const commander = commanderFor(`
      <button>Delete this package</button>
      <div role="dialog"><button>Cancel</button></div>
    `);

    const match = await markTarget(commander, {
      target: { selectors: [], texts: ['delete this package'] },
      scopeSelectors: ['[role="dialog"]'],
    });

    expect(match).toEqual({ found: false, reason: 'no-match' });
  });

  it('reports a missing container separately from a missing element', async () => {
    const commander = commanderFor('<button>Delete this package</button>');

    const match = await markTarget(commander, {
      target: { selectors: [], texts: ['delete this package'] },
      scopeSelectors: ['[role="dialog"]'],
    });

    expect(match).toEqual({ found: false, reason: 'no-container' });
  });
});

describe('readDialog', () => {
  it('reports the text and the number of fields to fill', async () => {
    const commander = commanderFor(`
      <div role="dialog">
        <p>Please type box to confirm.</p>
        <input type="text" name="verify">
      </div>
    `);

    const dialog = await readDialog(commander, SELECTORS.openDialog.selectors);

    expect(dialog.open).toBe(true);
    expect(dialog.inputs).toBe(1);
    expect(confirmationPhrase(dialog.text)).toBe('box');
  });

  it('reports no dialog when none is open', async () => {
    const dialog = await readDialog(
      commanderFor('<p>nothing</p>'),
      SELECTORS.openDialog.selectors
    );

    expect(dialog).toEqual({ open: false, text: '', inputs: 0 });
  });
});

describe('confirmationPhrase', () => {
  it('reads the phrase out of the prompt and never guesses it', () => {
    expect(confirmationPhrase('Please type box-dind to confirm.')).toBe(
      'box-dind'
    );
    expect(
      confirmationPhrase('To confirm, type "link-foundation/box" below')
    ).toBe(null);
    expect(confirmationPhrase('Type link-foundation/box to confirm')).toBe(
      'link-foundation/box'
    );
  });

  it('returns null when the dialog states no phrase', () => {
    expect(confirmationPhrase('Are you absolutely sure?')).toBe(null);
    expect(confirmationPhrase(null)).toBe(null);
  });
});

describe('selectVisibilityRadio', () => {
  it('checks the radio whose label names the visibility', async () => {
    const commander = commanderFor(`
      <div role="dialog">
        <label><input type="radio" name="visibility" value="public"> Public</label>
        <label><input type="radio" name="visibility" value="private" checked> Private</label>
      </div>
    `);

    expect(
      await selectVisibilityRadio(commander, {
        visibility: 'public',
        scopeSelectors: SELECTORS.openDialog.selectors,
      })
    ).toEqual({ selected: true, reason: undefined });

    const checked = await commander.evaluate({
      fn: () =>
        [...document.querySelectorAll('input[type="radio"]')]
          .filter((radio) => radio.checked)
          .map((radio) => radio.getAttribute('value')),
    });

    expect(checked).toEqual(['public']);
  });

  it('reports a dialog that offers no such option', async () => {
    const commander = commanderFor(
      '<div role="dialog"><p>no radios here</p></div>'
    );

    expect(
      await selectVisibilityRadio(commander, {
        visibility: 'internal',
        scopeSelectors: SELECTORS.openDialog.selectors,
      })
    ).toEqual({ selected: false, reason: 'no-radio' });
  });
});

describe('readReportedVisibility', () => {
  it('reads the sentence the settings page states', async () => {
    expect(
      await readReportedVisibility(
        commanderFor('<p>This package is currently public.</p>')
      )
    ).toBe('public');
  });

  it('falls back to a checked radio on the page itself', async () => {
    expect(
      await readReportedVisibility(
        commanderFor(
          '<input type="radio" name="visibility" value="internal" checked>'
        )
      )
    ).toBe('internal');
  });

  it('ignores the choice made inside a dialog that is still open', async () => {
    // A dialog that is still there means the change was not applied, so the
    // radio it holds is a request, not a result.
    expect(
      await readReportedVisibility(
        commanderFor(
          '<div role="dialog"><input type="radio" name="visibility" value="public" checked></div>'
        )
      )
    ).toBe(null);
  });

  it('reads nothing when the page says nothing', async () => {
    expect(await readReportedVisibility(commanderFor('<p>box</p>'))).toBe(null);
  });
});

const accessPage = `
  <ul>
    <li><a href="/orgs/link-foundation/teams/maintainers">maintainers</a>
      <select><option>Read</option><option selected>Admin</option></select>
      <button aria-label="Remove access">Remove</button></li>
    <li><a href="/konard">konard</a> Write
      <button aria-label="Remove access">Remove</button></li>
    <li><a href="/orgs/link-foundation/teams/observers">observers</a> no role control</li>
  </ul>
`;

describe('readAccessRows', () => {
  it('reads the teams and users that have access, with their roles', async () => {
    expect(
      await readAccessRows(commanderFor(accessPage), { roles: ROLES })
    ).toEqual([
      { type: 'team', name: 'maintainers', role: 'admin' },
      { type: 'user', name: 'konard', role: 'write' },
    ]);
  });
});

describe('markAccessRowControl', () => {
  it('marks a control inside the row of the grantee it was given', async () => {
    const commander = commanderFor(accessPage);

    const match = await markAccessRowControl(commander, {
      grantee: { type: 'user', name: 'konard' },
      labels: ['remove'],
    });

    expect(match.found).toBe(true);

    const row = await commander.evaluate({
      fn: ({ selector }) =>
        document.querySelector(selector).closest('li').innerText,
      args: [{ selector: MARKED_SELECTOR }],
    });

    expect(row).toContain('konard');
  });

  it('reports a grantee that has no row and never touches another row', async () => {
    expect(
      await markAccessRowControl(commanderFor(accessPage), {
        grantee: { type: 'team', name: 'nobody' },
        labels: ['remove'],
      })
    ).toEqual({ found: false, reason: 'no-row' });
  });

  it('reports a row that has no such control', async () => {
    expect(
      await markAccessRowControl(commanderFor(accessPage), {
        grantee: { type: 'team', name: 'observers' },
        labels: ['remove'],
      })
    ).toEqual({ found: false, reason: 'row-without-control' });
  });
});
