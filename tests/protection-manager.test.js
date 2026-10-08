import { describe, it, expect } from 'test-anywhere';
import { createProtectionManager } from '../src/protection/manager.js';
import {
  protectionApi,
  protectionRuleset,
  repository,
} from './fixtures/protection-api.js';

const target = { repo: { owner: 'acme', name: 'one' } };
const manager = (api) =>
  createProtectionManager({ rest: api.rest, verificationTimeout: 0 });
const writes = (api) => api.calls.filter((call) => call.method !== 'GET');
const unavailable = ({ path }) =>
  path.includes('/rulesets')
    ? { status: 403, message: 'Upgrade your plan for rulesets' }
    : null;

describe('protection manager fallback and verification', () => {
  it('protects every current branch through classic protection when rulesets are unavailable', async () => {
    const api = protectionApi({ reject: unavailable });
    const result = await manager(api).protect(target, { confirm: () => true });
    expect(result.repositories[0].verified).toBe(true);
    expect(writes(api).map((call) => call.path)).toEqual([
      '/repos/acme/one/branches/main/protection',
      '/repos/acme/one/branches/feature%2Fwork/protection',
    ]);
    expect(writes(api)[0].body.allow_deletions).toBe(false);
    expect(writes(api)[0].body.allow_force_pushes).toBe(false);
    expect(result.repositories[0].limitation).toContain(
      'current branches only'
    );
  });

  it('preserves required checks, reviews, restrictions and stronger classic settings', async () => {
    const existing = {
      required_status_checks: {
        strict: true,
        contexts: ['build'],
        checks: [{ context: 'build', app_id: 3 }],
      },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        dismissal_restrictions: { teams: [{ slug: 'maintainers' }] },
        bypass_pull_request_allowances: { users: [{ login: 'bot' }] },
      },
      restrictions: {
        users: [{ login: 'owner' }],
        teams: [{ slug: 'maintainers' }],
        apps: [{ slug: 'release' }],
      },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_deletions: true,
      allow_force_pushes: true,
    };
    const api = protectionApi({
      reject: unavailable,
      protections: { '/repos/acme/one/branches/main/protection': existing },
    });
    const result = await manager(api).protect(target, { confirm: () => true });
    expect(result.repositories[0].verified).toBe(true);
    const body = writes(api)[0].body;
    expect(body.required_status_checks).toEqual(
      existing.required_status_checks
    );
    expect(body.enforce_admins).toBe(true);
    expect(
      body.required_pull_request_reviews.required_approving_review_count
    ).toBe(2);
    expect(
      body.required_pull_request_reviews.dismissal_restrictions.teams
    ).toEqual(['maintainers']);
    expect(body.restrictions.apps).toEqual(['release']);
    expect(body.required_linear_history).toBe(true);
  });

  it('falls back to classic after a repository ruleset creation is refused', async () => {
    const api = protectionApi({
      reject: ({ path, method }) =>
        path.endsWith('/rulesets') && method === 'POST'
          ? { status: 422, message: 'Rulesets not available for this plan' }
          : null,
    });
    const result = await manager(api).protect(target, { confirm: () => true });
    expect(result.repositories[0].route).toBe('classic');
    expect(result.repositories[0].verified).toBe(true);
    expect(writes(api).length).toBe(3);
  });

  it('reports an unavailable classic endpoint and continues with other repositories', async () => {
    const api = protectionApi({
      repositories: [repository('one'), repository('two')],
      reject: ({ path }) =>
        path.startsWith('/repos/acme/one/')
          ? { status: 403, message: 'Upgrade required' }
          : null,
    });
    const result = await manager(api).protect(
      { user: 'acme' },
      { confirm: () => true }
    );
    expect(result.repositories[0].action).toBe('failed');
    expect(result.repositories[0].reason).toContain('Classic fallback failed');
    expect(result.repositories[1].verified).toBe(true);
  });

  it('does not claim success when effective branch rules fail verification', async () => {
    const api = protectionApi({ unverified: true });
    const result = await manager(api).protect(target);
    expect(result.repositories[0].action).toBe('failed');
    expect(result.repositories[0].exitCode).toBe(6);
    expect(writes(api).length).toBe(1);
  });

  it('fails verification when a classic write has not taken effect', async () => {
    const api = protectionApi({ reject: unavailable, unverified: true });
    const result = await manager(api).protect(target, { confirm: () => true });
    expect(result.repositories[0].exitCode).toBe(6);
  });
});

describe('protection policy safety and enumeration', () => {
  it('keeps all existing rulesets and refuses conflicting parameters', async () => {
    const api = protectionApi({
      rulesets: {
        '/repos/acme/one/rulesets': [
          protectionRuleset({
            rules: [
              {
                type: 'pull_request',
                parameters: { required_approving_review_count: 3 },
              },
            ],
          }),
        ],
      },
    });
    const result = await manager(api).protect(target, {
      rules: [
        {
          type: 'pull_request',
          parameters: { required_approving_review_count: 1 },
        },
      ],
      confirm: () => true,
    });
    expect(result.repositories[0].action).toBe('failed');
    expect(result.repositories[0].reason).toContain('without loosening');
    expect(writes(api).length).toBe(0);
  });

  it('creates an independent ruleset when an inherited namesake is insufficient', async () => {
    const api = protectionApi({
      rulesets: {
        '/repos/acme/one/rulesets': [
          protectionRuleset({
            source_type: 'Organization',
            source: 'acme',
            rules: [{ type: 'deletion' }],
          }),
        ],
      },
    });
    const result = await manager(api).protect(target);
    expect(result.repositories[0].verified).toBe(true);
    expect(writes(api)[0].method).toBe('POST');
    expect(api.rulesets.get('/repos/acme/one/rulesets').length).toBe(2);
  });

  it('includes every pagination page and authenticated private repositories', async () => {
    const repositories = Array.from({ length: 101 }, (_, index) =>
      repository(`repo-${index}`)
    );
    const api = protectionApi({ repositories });
    const plan = await manager(api).plan({ user: 'acme' });
    expect(plan.repositories.length).toBe(101);
    expect(
      api.calls.some((call) =>
        call.path.includes('/users/acme/repos?type=owner&per_page=100&page=2')
      )
    ).toBe(true);
    expect(
      api.calls.some((call) =>
        call.path.startsWith('/user/repos?affiliation=owner&visibility=all')
      )
    ).toBe(true);
  });

  it('does not fall back for validation errors, rate limits or server failures', async () => {
    for (const rejection of [
      { status: 422, message: 'Invalid rule parameters' },
      { status: 403, message: 'API rate limit exceeded' },
      { status: 503, message: 'Service unavailable' },
    ]) {
      const api = protectionApi({
        reject: ({ method }) => (method === 'POST' ? rejection : null),
      });
      const result = await manager(api).protect(target);
      expect(result.repositories[0].action).toBe('failed');
      expect(writes(api).length).toBe(1);
    }
  });

  it('refuses unsupported stricter rules on the classic route without writes', async () => {
    const api = protectionApi({ reject: unavailable });
    const result = await manager(api).protect(target, {
      rules: [{ type: 'required_signatures' }],
      confirm: () => true,
    });
    expect(result.repositories[0].action).toBe('failed');
    expect(result.repositories[0].reason).toContain('cannot represent');
    expect(writes(api).length).toBe(0);
  });
});

describe('protection concurrency and empty repositories', () => {
  it('marks archived repositories as skipped and unchanged after an organization write', async () => {
    const api = protectionApi({
      repositories: [repository('old', { archived: true })],
    });
    const result = await manager(api).protect(
      { org: 'acme' },
      { confirm: () => true }
    );
    expect(result.repositories[0].action).toBe('skipped');
    expect(result.repositories[0].changed).toBe(false);
  });
  it('refuses a concurrent ruleset edit', async () => {
    const api = protectionApi({
      rulesets: {
        '/repos/acme/one/rulesets': [
          protectionRuleset({ rules: [{ type: 'deletion' }] }),
        ],
      },
    });
    const result = await manager(api).protect(target, {
      confirm: () => true,
      onPlan: () => {
        api.rulesets
          .get('/repos/acme/one/rulesets')[0]
          .rules.push({ type: 'required_signatures' });
      },
    });
    expect(result.repositories[0].action).toBe('failed');
    expect(result.repositories[0].reason).toContain(
      'differs from the reviewed plan'
    );
    expect(writes(api).length).toBe(0);
  });

  it('creates a future-branch ruleset for an empty repository', async () => {
    const api = protectionApi({ empty: true });
    const result = await manager(api).protect(target);
    expect(result.repositories[0].verified).toBe(true);
    expect(result.repositories[0].branchVerification).toContain('No branches');
  });

  it('requires an API token for protection', async () => {
    let error;
    try {
      await manager(protectionApi({ noToken: true })).plan(target);
    } catch (caught) {
      error = caught;
    }
    expect(error.exitCode).toBe(3);
  });
});
