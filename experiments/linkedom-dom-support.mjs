/**
 * Which parts of the DOM linkedom implements, and which the tests must fill in.
 *
 * The page functions in `src/browser/dom.js` are tested against linkedom, with
 * no real Chrome. This script records what that costs: everything the
 * drivers rely on works except layout boxes and radio-button clicking, which is
 * why `tests/fixtures/fake-browser.js` shims exactly those two things.
 *
 * Run with: node experiments/linkedom-dom-support.mjs
 */

import { parseHTML } from 'linkedom';

const { document, Element } = parseHTML(`<!doctype html><html><head>
<title>box · Packages</title><meta name="user-login" content="konard">
</head><body>
<a href="/orgs/link-foundation/packages/container/package/box">box</a>
<button aria-label="Change visibility">Change</button>
<input type="radio" name="visibility" value="public">
<select><option>Read</option><option selected>Admin</option></select>
</body></html>`);

const button = document.querySelector('button');
const radio = document.querySelector('input[type="radio"]');
const select = document.querySelector('select');

const report = {
  'element.innerText': button.innerText === 'Change',
  'document.title': document.title.startsWith('box'),
  'element.closest': typeof button.closest === 'function',
  'addEventListener/click': (() => {
    let fired = false;
    button.addEventListener('click', () => {
      fired = true;
    });
    button.click();
    return fired;
  })(),
  'select.options': select.options.length === 2,
  'option.selected':
    [...select.options].find((option) => option.selected)?.textContent ===
    'Admin',
  // Not implemented by linkedom, shimmed by tests/fixtures/fake-browser.js.
  'select.selectedIndex': select.selectedIndex !== undefined,
  'option.text': [...select.options][1].text !== undefined,
  'getBoundingClientRect reports a size':
    button.getBoundingClientRect().width > 0,
  'clicking a radio checks it': (() => {
    radio.click();
    return radio.checked === true;
  })(),
};

for (const [feature, supported] of Object.entries(report)) {
  console.log(`${supported ? 'yes' : 'no '}  ${feature}`);
}

console.log(
  `\nElement.prototype.getBoundingClientRect exists: ${typeof Element.prototype
    .getBoundingClientRect}`
);
