import { describe, it, expect } from 'test-anywhere';
import {
  readSecurityFeatures,
  setSecurityFeature,
} from '../src/browser/security-settings.js';
import { createSecurityGateway } from '../src/security/gateway.js';
import { createFakeSession } from './fixtures/fake-browser.js';
import { securityPages } from './fixtures/github-security-pages.js';
import { createLogger } from '../src/logging.js';

const log = createLogger({ stdout: () => {}, stderr: () => {} });
function fixture(extra) {
  const pages = securityPages();
  const route = pages.routes[pages.url];
  const html = route.html;
  route.html = () =>
    html().replace(
      '</body>',
      `${typeof extra === 'function' ? extra(pages.state) : extra}</body>`
    );
  return { pages, session: createFakeSession({ routes: pages.routes }) };
}
describe('all security page rows', () => {
  it('discovers additional named rows and retains their state', async () => {
    const { pages, session } = fixture(
      '<div class="Box-row"><h3>Future security feature</h3><button>Disable</button></div>'
    );
    const rows = await readSecurityFeatures(session, { repo: pages.repo, log });
    const row = Object.values(rows).find(
      (r) => r.label === 'Future security feature'
    );
    expect(row.state).toBe('enabled');
  });
  it('retains headings that have the same punctuation-stripped spelling', async () => {
    const { pages, session } = fixture(
      '<div class="Box-row"><h3>Future: toggle</h3><button>Enable</button></div><div class="Box-row"><h3>Future toggle</h3><button>Disable</button></div>'
    );
    const rows = Object.values(
      await readSecurityFeatures(session, { repo: pages.repo, log })
    );
    expect(rows.find((row) => row.label === 'Future: toggle').state).toBe(
      'disabled'
    );
    expect(rows.find((row) => row.label === 'Future toggle').state).toBe(
      'enabled'
    );
  });
  it('reads policy-owned rows without a control', async () => {
    const { pages, session } = fixture(
      '<div class="Box-row"><h3>Future policy setting</h3><span>Enabled for all repositories in the organization</span></div>'
    );
    const rows = await readSecurityFeatures(session, { repo: pages.repo, log });
    const row = Object.values(rows).find(
      (r) => r.label === 'Future policy setting'
    );
    expect(row.state).toBe('enabled');
    expect(row.locked).toBe(true);
  });
  it('reads checkbox toggles', async () => {
    const { pages, session } = fixture(
      '<div class="Box-row"><h3>Future checkbox</h3><input type="checkbox" checked></div>'
    );
    const rows = await readSecurityFeatures(session, { repo: pages.repo, log });
    expect(
      Object.values(rows).find((r) => r.label === 'Future checkbox').state
    ).toBe('enabled');
  });
  it('includes unknown defaults for discovered rows in gateway status', async () => {
    const { pages, session } = fixture(
      '<div class="Box-row"><h3>Future setting</h3><button>Enable</button></div>'
    );
    const gateway = createSecurityGateway({
      repo: pages.repo,
      log,
      getSession: async () => session,
      rest: {
        hasToken: false,
        send: async () => ({ body: { visibility: 'public' } }),
      },
    });
    const row = (await gateway.readAll()).find(
      (r) => r.label === 'Future setting'
    );
    expect(row.state).toBe('disabled');
    expect(row.defaultState).toBe('unknown');
    expect(row.differsFromDefault).toBe(null);
  });
  it('can write a newly discovered page toggle by its explicit heading', async () => {
    const { pages, session } = fixture(
      (state) =>
        `<div class="Box-row"><h3>Future toggle</h3><button data-feature="page-future-toggle" data-action="${state.features['page-future-toggle'] === 'enabled' ? 'disable' : 'enable'}">${state.features['page-future-toggle'] === 'enabled' ? 'Disable' : 'Enable'}</button></div>`
    );
    const row = Object.values(
      await readSecurityFeatures(session, { repo: pages.repo, log })
    ).find((r) => r.label === 'Future toggle');
    const result = await setSecurityFeature(session, {
      repo: pages.repo,
      log,
      feature: { id: row.id, label: row.label, headings: ['future toggle'] },
      enabled: true,
      settleTimeout: 0,
    });
    expect(pages.state.clicks[0].feature).toBe('page-future-toggle');
    expect(result.reported).toBe('enabled');
  });
});
