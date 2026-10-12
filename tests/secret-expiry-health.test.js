/* eslint local/no-changelog-comments: ["warn", { "allowDatesInStrings": true }] -- Expiry fixtures use ISO dates. */
import { describe, it, expect } from 'test-anywhere';
import { createSecretHealth } from '../src/secrets/health.js';
import { actionsApi } from './fixtures/actions-api.js';
import { apiCommand } from './fixtures/cli.js';

const now = () => Date.parse('2026-10-13T00:00:00Z');
const scope = { org: 'acme' };
const inspectRepo = (api) =>
  createSecretHealth({ rest: api.rest, now }).health('CUSTOM_TOKEN', {
    scope: { repo: 'acme/one' },
  });

function expiryApi(value, status = 200) {
  return actionsApi({
    routes: {
      '/orgs/acme/repos': { body: [{ full_name: 'acme/one' }] },
      '/orgs/acme/actions/variables/CUSTOM_TOKEN_EXPIRES_AT': {
        status,
        body: { value },
      },
    },
  });
}

describe('recorded secret expiry in health', () => {
  for (const [date, status] of [
    ['2026-10-18', 'expiring'],
    ['2026-10-13', 'expired'],
    ['2026-10-12', 'expired'],
  ]) {
    it(`reports ${status} from metadata even when publishing succeeded`, async () => {
      const api = expiryApi(date);
      const result = await createSecretHealth({ rest: api.rest, now }).health(
        'CUSTOM_TOKEN',
        { scope }
      );
      expect(result.status).toBe(status);
      expect(result.expiresAt).toBe(`${date}T00:00:00.000Z`);
      expect(result.expiry.status).toBe(status);
      expect(result.evidence[0].status).toBe('ok');
    });
  }

  it('warns about absent organization expiry with an actionable command', async () => {
    const api = expiryApi(undefined, 404);
    const result = await apiCommand(
      ['secret', 'health', 'CUSTOM_TOKEN', '--org', 'acme', '--json'],
      api
    );
    const health = JSON.parse(result.output);
    expect(health.expiry.reason).toBe('expiry-absent');
    expect(health.warnings[0]).toContain('secret set');
    expect(health.warnings[0]).toContain('--expires-at');
    expect(result.errors).toContain('Expiry unknown');
  });

  it('keeps malformed or unreadable metadata distinct from absent expiry', async () => {
    for (const [value, httpStatus, reason] of [
      ['not-a-date', 200, 'expiry-invalid'],
      [undefined, 403, 'expiry-unreadable'],
    ]) {
      const api = expiryApi(value, httpStatus);
      const result = await createSecretHealth({ rest: api.rest, now }).health(
        'CUSTOM_TOKEN',
        { scope }
      );
      expect(result.expiry.status).toBe('unknown');
      expect(result.expiry.reason).toBe(reason);
      expect(result.evidence[0].status).toBe('ok');
    }
  });

  it('uses accessible organization metadata for repository health without admin:org', async () => {
    const api = actionsApi({
      routes: {
        '/repos/acme/one/actions/organization-variables': {
          body: {
            variables: [
              { name: 'CUSTOM_TOKEN_EXPIRES_AT', value: '2026-10-18' },
            ],
          },
        },
      },
    });
    const result = await inspectRepo(api);
    expect(result.status).toBe('expiring');
    expect(api.calls.some((call) => call.path.startsWith('/orgs/'))).toBe(
      false
    );
  });

  it('prefers repository metadata and honors the rotation window', async () => {
    const api = actionsApi({
      routes: {
        '/repos/acme/one/actions/variables/CUSTOM_TOKEN_EXPIRES_AT': {
          body: { value: '2026-10-18' },
        },
      },
    });
    const health = createSecretHealth({ rest: api.rest, now });
    expect(
      (
        await health.health('CUSTOM_TOKEN', {
          scope: { repo: 'acme/one' },
          rotateBeforeMs: 86400000,
        })
      ).status
    ).toBe('ok');
    expect(
      api.calls.some((call) => call.path.endsWith('/organization-variables'))
    ).toBe(false);
  });

  it('does not apply organization expiry to a repository secret override', async () => {
    const api = actionsApi({
      routes: {
        '/repos/acme/one/actions/secrets/CUSTOM_TOKEN': {
          body: { name: 'CUSTOM_TOKEN' },
        },
        '/repos/acme/one/actions/organization-variables': {
          body: {
            variables: [
              { name: 'CUSTOM_TOKEN_EXPIRES_AT', value: '2000-01-01' },
            ],
          },
        },
      },
    });
    const result = await inspectRepo(api);
    expect(result.status).toBe('ok');
    expect(result.expiry.reason).toBe('expiry-absent');
    expect(
      api.calls.some((call) => call.path.endsWith('/organization-variables'))
    ).toBe(false);
  });

  it('warns about missing expiry on an organization secret visible to a repository', async () => {
    const api = actionsApi({
      routes: {
        '/repos/acme/one/actions/organization-secrets': {
          body: { secrets: [{ name: 'CUSTOM_TOKEN' }] },
        },
      },
    });
    const result = await inspectRepo(api);
    expect(result.warnings[0]).toContain('--org acme');
    expect(result.expiry.scope).toEqual({ org: 'acme' });
  });
});
