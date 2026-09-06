/**
 * A browser-commander stand-in backed by a real DOM implementation.
 *
 * The page drivers are the part of gh-manager most likely to break silently,
 * and driving a real Chrome in CI is neither fast nor reliable. Every page
 * function in `src/browser/dom.js` is self-contained and receives exactly one
 * serializable argument, so running it against a parsed document exercises the
 * shipped code — selectors, text matching, and all — without a browser.
 *
 * Two behaviours a real engine provides are filled in here: layout boxes, so
 * the visibility checks can distinguish a rendered element from a hidden one,
 * and radio buttons that become checked when they are clicked.
 */

import { parseHTML } from 'linkedom';

/** Size reported for any element that is not explicitly hidden. */
const VISIBLE_BOX = { x: 0, y: 0, top: 0, left: 0, width: 120, height: 24 };

/** Size reported for a hidden element. */
const HIDDEN_BOX = { x: 0, y: 0, top: 0, left: 0, width: 0, height: 0 };

/**
 * Decide whether an element would be rendered.
 * @param {Object} element - DOM element
 * @returns {boolean} True when the element is visible
 */
function isRendered(element) {
  for (
    let node = element;
    node && node.getAttribute;
    node = node.parentElement
  ) {
    if (
      node.hasAttribute('hidden') ||
      /display:\s*none/i.test(node.getAttribute('style') ?? '')
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Give radio buttons the click behaviour browsers give them.
 * @param {Object} document - Document to wire
 * @returns {void}
 */
function wireRadios(document) {
  for (const radio of document.querySelectorAll('input[type="radio"]')) {
    if (radio.ghManagerWired) {
      continue;
    }

    radio.ghManagerWired = true;
    radio.addEventListener('click', () => {
      const group = radio.getAttribute('name');

      for (const other of document.querySelectorAll('input[type="radio"]')) {
        if (other.getAttribute('name') === group) {
          other.checked = false;
          other.removeAttribute('checked');
        }
      }

      radio.checked = true;
      radio.setAttribute('checked', '');
    });
  }
}

/**
 * Parse a page and apply the browser behaviours the drivers rely on.
 * @param {string} html - Page markup
 * @returns {Object} linkedom window
 */
function loadPage(html) {
  const dom = parseHTML(html);

  dom.Element.prototype.getBoundingClientRect = function boundingBox() {
    return isRendered(this) ? { ...VISIBLE_BOX } : { ...HIDDEN_BOX };
  };

  wireRadios(dom.document);
  return dom;
}

/**
 * Markup served for a URL no route claims.
 *
 * GitHub keeps the visitor signed in on a 404, which is why the account meta
 * tag is present here too: a missing package must be reported as missing, not
 * as a sign-in problem.
 */
const NOT_FOUND_PAGE =
  '<!doctype html><html><head><title>Page not found · GitHub</title><meta name="user-login" content="konard"></head><body>404</body></html>';

/**
 * Create a fake browser session.
 *
 * A route is `{html, onClick, onFill}`: `html` is the page markup, or a
 * function returning it so a fixture can render its own state, `onClick` is
 * called with the clicked element whenever something on that page is clicked,
 * which is how a fixture opens a dialog or navigates in response to a submit,
 * and `onFill` is called after typing, which is how a search field renders its
 * results.
 * @param {Object} options - Session options
 * @param {Object<string, Object|string>} options.routes - URL to route
 * @param {string} [options.start] - URL to open first
 * @returns {Object} Session with `commander`, plus `visited` and `clicks` logs
 */
export function createFakeSession({ routes, start }) {
  const visited = [];
  const clicks = [];
  const captures = [];
  let current = null;
  let currentUrl = '';
  let currentRoute = null;

  /**
   * Resolve the element a selector points at on the current page.
   * @param {string} selector - CSS selector
   * @returns {Object|null} Element or null
   */
  const find = (selector) => current.document.querySelector(selector);

  /**
   * Open a URL, serving the 404 page when no route claims it.
   * @param {string} url - Destination
   * @returns {void}
   */
  function navigate(url) {
    visited.push(url);
    const route = routes[url];
    const resolved = typeof route === 'string' ? { html: route } : route;

    const html =
      typeof resolved?.html === 'function' ? resolved.html() : resolved?.html;

    currentUrl = url;
    currentRoute = resolved ?? null;
    current = loadPage(html ?? NOT_FOUND_PAGE);
  }

  if (start) {
    navigate(start);
  }

  const commander = {
    /**
     * Navigate to a URL.
     * @param {Object} options - Navigation options
     * @param {string} options.url - Destination
     * @returns {Promise<Object>} Navigation result
     */
    async goto({ url }) {
      navigate(url);
      return { navigated: true };
    },

    /**
     * Report the URL currently open.
     * @returns {string} Current URL
     */
    getUrl() {
      return currentUrl;
    },

    /**
     * Run a page function against the current document.
     * @param {Object} options - Evaluation options
     * @param {Function} options.fn - Function to run in the page
     * @param {Array} [options.args] - Single serializable argument
     * @returns {Promise<any>} Whatever the page function returned
     */
    async evaluate({ fn, args = [] }) {
      const previous = globalThis.document;
      globalThis.document = current.document;

      try {
        return await fn(...args);
      } finally {
        globalThis.document = previous;
      }
    },

    /**
     * Click an element and let the fixture react to it.
     * @param {Object} options - Click options
     * @param {string} options.selector - CSS selector
     * @returns {Promise<Object>} Click result
     */
    async click({ selector }) {
      const element = find(selector);

      if (!element) {
        return { clicked: false, navigated: false, reason: 'no-element' };
      }

      clicks.push({ url: currentUrl, text: (element.innerText ?? '').trim() });
      const before = currentUrl;
      element.click();
      currentRoute?.onClick?.(element, {
        document: current.document,
        navigate,
      });

      if (currentUrl === before) {
        wireRadios(current.document);
      }

      return { clicked: true, navigated: currentUrl !== before };
    },

    /**
     * Type into a field.
     * @param {Object} options - Fill options
     * @param {string} options.selector - CSS selector
     * @param {string} options.text - Value to type
     * @returns {Promise<Object>} Fill result
     */
    async fill({ selector, text }) {
      const element = find(selector);

      if (element) {
        element.value = text;
        currentRoute?.onFill?.(element, {
          document: current.document,
          navigate,
        });
      }

      return { filled: Boolean(element) };
    },

    /**
     * Read a field's value.
     * @param {Object} options - Options
     * @param {string} options.selector - CSS selector
     * @returns {Promise<string|null>} Current value
     */
    async inputValue({ selector }) {
      return find(selector)?.value ?? null;
    },

    /**
     * Stand in for a wait; the fake DOM changes synchronously.
     * @returns {Promise<void>} Resolves immediately
     */
    async wait() {},

    /**
     * Close the session.
     * @returns {Promise<void>} Resolves immediately
     */
    async destroy() {},
  };

  return {
    commander,
    visited,
    clicks,
    captures,

    /**
     * Record a failure capture without writing screenshots.
     * @param {string} label - Failure label
     * @returns {Promise<string[]>} Artifact paths
     */
    async capture(label) {
      captures.push(label);
      return [`/logs/${label}.png`];
    },

    /**
     * Close the session.
     * @returns {Promise<void>} Resolves immediately
     */
    async close() {},
  };
}
