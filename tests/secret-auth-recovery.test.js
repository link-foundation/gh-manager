/* eslint local/no-changelog-comments: ["warn", { "allowDatesInStrings": true }] -- Expiry fixtures use ISO dates. */
import { describe, it, expect } from 'test-anywhere';
import { apiCommand } from './fixtures/cli.js';
import { secretsApi } from './fixtures/secrets-api.js';

async function recoveryCommand({
  source = 'gh auth token',
  failedRefresh = false,
  deniedAfterRefresh = false,
  dryRun = false,
  status = 403,
  verb = 'set',
} = {}) {
  const api = await secretsApi();
  const send = api.rest.send;
  let refreshed = false;
  let attempts = 0;
  let reads = 0;
  const clientTokens = [];
  const denied = {
    ...api.rest,
    send: (path, options) =>
      path.includes('/orgs/') && (!refreshed || deniedAfterRefresh)
        ? Promise.resolve({ status, ok: false })
        : send(path, options),
  };
  const result = await apiCommand(
    [
      'secret',
      verb,
      'CUSTOM_TOKEN',
      '--org',
      'acme',
      '--visibility',
      'all',
      '--expires-at',
      '2099-01-01',
      '--json',
      ...(dryRun ? ['--dry-run'] : []),
    ],
    { rest: denied },
    {
      resolveToken: () => ({
        token: refreshed ? 'refreshed-token' : 'old-token',
        source,
      }),
      createRest: ({ token }) => {
        clientTokens.push(token);
        return denied;
      },
      readSecret: () => {
        reads++;
        return 'private-value';
      },
      refreshGhAuth: async () => {
        attempts++;
        if (failedRefresh) {
          throw new Error('private-value');
        }
        refreshed = true;
        return 'refreshed-token';
      },
    }
  );
  return { ...api, ...result, attempts, reads, clientTokens };
}

describe('organization secret scope recovery', () => {
  it('refreshes a gh CLI login once and continues the original write and expiry', async () => {
    const result = await recoveryCommand();
    expect(result.code).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.clientTokens).toEqual(['old-token', 'refreshed-token']);
    expect(result.reads).toBe(1);
    expect(result.secrets.get('CUSTOM_TOKEN').value).toBe('private-value');
    expect(result.variables.get('CUSTOM_TOKEN_EXPIRES_AT').value).toBe(
      '2099-01-01T00:00:00.000Z'
    );
    expect(result.output + result.errors).not.toContain('private-value');
  });

  it('recovers ensure before acquisition without falling back to repository writes', async () => {
    const result = await recoveryCommand({ verb: 'ensure' });
    expect(result.code).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.reads).toBe(1);
    expect(
      result.calls.filter(
        (call) => call.path.includes('/secrets/') && call.method === 'PUT'
      ).length
    ).toBe(1);
  });

  it('does not replace an explicitly supplied token or an environment token', async () => {
    for (const source of [
      '--token',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_MANAGER_TOKEN',
    ]) {
      const result = await recoveryCommand({ source });
      expect(result.code).toBe(3);
      expect(result.attempts).toBe(0);
    }
  });

  it('does not loop after a persistent denial or expose refresh errors', async () => {
    for (const options of [
      { deniedAfterRefresh: true },
      { failedRefresh: true },
    ]) {
      const result = await recoveryCommand(options);
      expect(result.code).toBe(3);
      expect(result.attempts).toBe(1);
      expect(result.output + result.errors).not.toContain('private-value');
    }
  });

  it('never opens authentication on dry runs or server failures', async () => {
    for (const options of [{ dryRun: true }, { status: 500 }]) {
      const result = await recoveryCommand(options);
      expect(result.attempts).toBe(0);
    }
  });
});
