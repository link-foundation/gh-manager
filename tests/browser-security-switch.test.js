import { describe, it, expect } from 'test-anywhere';
import { createLogger } from '../src/logging.js';
import { findSecurityFeature } from '../src/security/features.js';
import {
  readSecurityFeatures,
  setSecurityFeature,
} from '../src/browser/security-settings.js';
import { repoSecuritySettingsUrl } from '../src/browser/selectors.js';
import { createFakeSession } from './fixtures/fake-browser.js';

const repo = { owner: 'acme', name: 'one' };
const graph = findSecurityFeature('dependency-graph');
const log = createLogger({ stdout: () => {}, stderr: () => {} });

// Sanitized structure of GitHub's ControlGroup / security-settings-toggle UI.
function switchPage({ enabled = false, disabled = false } = {}) {
  const state = { enabled, clicks: [] };
  const url = repoSecuritySettingsUrl(repo);
  const row = (id, label, pressed, locked = false) => `
    <div class="ControlGroup-item">
      <div class="ControlGroup-item-contents">
        <p class="ControlGroup-item-title"><span id="${id}-label">${label}</span></p>
        <div class="ControlGroup-item-control"><security-settings-toggle>
          <form><toggle-switch>
            <span aria-hidden="true">On Off</span>
            <button type="button" data-target="toggle-switch.switch"
              aria-labelledby="${id}-label" aria-pressed="${pressed}"
              ${locked ? 'disabled' : ''}></button>
          </toggle-switch><button type="submit" aria-hidden="true"></button></form>
        </security-settings-toggle></div>
      </div>
    </div>`;
  const session = createFakeSession({
    routes: {
      [url]: {
        html: `<!doctype html><html><head><meta name="user-login" content="acme"></head>
          <body><button>Enable all</button>
          ${row('dependency-graph', 'Dependency graph', enabled, disabled)}
          ${row('alerts', 'Dependabot alerts', true)}</body></html>`,
        onClick(element) {
          state.clicks.push(element.getAttribute('aria-labelledby'));
          if (
            element.getAttribute('aria-labelledby') === 'dependency-graph-label'
          ) {
            state.enabled = !state.enabled;
            element.setAttribute('aria-pressed', String(state.enabled));
          }
        },
      },
    },
  });
  return { state, session };
}

describe('GitHub security toggle buttons', () => {
  it('reads pressed state and changes only the named feature', async () => {
    const { state, session } = switchPage();
    const rows = await readSecurityFeatures(session, { repo, log });
    expect(rows['dependency-graph'].state).toBe('disabled');
    expect(rows['vulnerability-alerts'].state).toBe('enabled');

    const result = await setSecurityFeature(session, {
      repo,
      feature: graph,
      enabled: true,
      log,
    });
    expect(result).toEqual({ changed: true, reported: 'enabled' });
    expect(state.enabled).toBe(true);
    expect(state.clicks).toEqual(['dependency-graph-label']);
  });

  it('leaves an already enabled toggle unchanged', async () => {
    const { state, session } = switchPage({ enabled: true });
    const result = await setSecurityFeature(session, {
      repo,
      feature: graph,
      enabled: true,
      log,
    });
    expect(result).toEqual({ changed: false, reported: 'enabled' });
    expect(state.clicks).toEqual([]);
  });

  it('refuses a disabled toggle without clicking another control', async () => {
    const { state, session } = switchPage({ disabled: true });
    let error;
    try {
      await setSecurityFeature(session, {
        repo,
        feature: graph,
        enabled: true,
        log,
      });
    } catch (failure) {
      error = failure;
    }
    expect(error.message).toContain('organization or enterprise policy');
    expect(state.clicks).toEqual([]);
  });
});
