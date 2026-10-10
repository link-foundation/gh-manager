import { describe, it, expect } from 'test-anywhere';
import { createSecretManager } from '../src/secrets/manager.js';
import { secretsApi } from './fixtures/secrets-api.js';

async function fixture(status = 403) {
  const repo = await secretsApi({ base: '/repos/acme/one/actions' });
  const send = repo.rest.send;
  repo.rest.send = (path, options) =>
    path.startsWith('/orgs/')
      ? Promise.resolve({ status, ok: false })
      : send(path, options);
  return {
    ...repo,
    manager: createSecretManager({
      rest: repo.rest,
      scope: { org: 'acme' },
      verificationTimeout: 0,
    }),
  };
}

const ensureCustom = (manager) =>
  manager.ensure('CUSTOM_TOKEN', {
    repos: ['one'],
    acquire: () => 'private-value',
  });

describe('fallback across selected repositories', () => {
  it('acquires once for every absent repository and delays revocation until all writes are verified', async () => {
    const first = await secretsApi({ base: '/repos/acme/one/actions' });
    const second = await secretsApi({ base: '/repos/acme/two/actions' });
    for (const api of [first, second]) {
      api.secrets.set('CUSTOM_TOKEN', {
        name: 'CUSTOM_TOKEN',
        value: 'original',
      });
    }
    const rest = {
      hasToken: true,
      request: async () => null,
      send: (path, options) =>
        path.startsWith('/orgs/')
          ? Promise.resolve({ status: 422, ok: false })
          : (path.startsWith('/repos/acme/one/') ? first : second).rest.send(
              path,
              options
            ),
    };
    let acquired = 0;
    const revoked = [];
    const manager = createSecretManager({
      rest,
      scope: { org: 'acme' },
      verificationTimeout: 0,
    });
    const result = await manager.ensure('CUSTOM_TOKEN', {
      repos: ['one', 'two', 'one'],
      health: { status: 'auth-failing' },
      acquire: () => {
        acquired++;
        return 'replacement';
      },
      revokePrevious: ({ scope }) => {
        expect(first.secrets.get('CUSTOM_TOKEN').value).toBe('replacement');
        expect(second.secrets.get('CUSTOM_TOKEN').value).toBe('replacement');
        revoked.push(scope.repo.name);
      },
    });
    expect(acquired).toBe(1);
    expect(revoked).toEqual(['one', 'two']);
    expect(result.results.length).toBe(2);
    expect(result.valueChanged).toBe(true);
    expect(result.fallbackReason).toContain('422');
  });
});

describe('organization-first minimum-change secrets', () => {
  it('adds missing selected repository grants without replacing a present secret or dropping old grants', async () => {
    const f = await secretsApi();
    f.secrets.set('CUSTOM_TOKEN', {
      name: 'CUSTOM_TOKEN',
      visibility: 'selected',
      selected_repository_ids: [11],
    });
    const manager = createSecretManager({
      rest: f.rest,
      scope: { org: 'acme' },
      verificationTimeout: 0,
    });
    const result = await manager.ensure('CUSTOM_TOKEN', {
      repos: ['two'],
      health: { status: 'ok' },
      acquire: () => {
        throw new Error('must not acquire');
      },
    });
    expect(result.path).toBe('organization');
    expect(result.changed).toBe(true);
    expect(result.valueChanged).toBe(false);
    expect(f.secrets.get('CUSTOM_TOKEN').selected_repository_ids).toEqual([
      11, 22,
    ]);
    expect(
      f.calls.filter((call) => call.method === 'PUT').map((call) => call.path)
    ).toEqual(['/orgs/acme/actions/secrets/CUSTOM_TOKEN/repositories/22']);
  });
  it('falls back on organization refusal and reports the reason and repository scope', async () => {
    const f = await fixture();
    const result = await ensureCustom(f.manager);
    expect(result.path).toBe('repository');
    expect(result.fallbackReason).toContain('403');
    expect(result.results[0].scope.repo).toEqual({
      owner: 'acme',
      name: 'one',
    });
    expect(f.secrets.get('CUSTOM_TOKEN').value).toBe('private-value');
    expect(JSON.stringify(result)).not.toContain('private-value');
  });
  it('keeps a present repository secret of unknown health without acquiring or writing', async () => {
    const f = await fixture(404);
    f.secrets.set('CUSTOM_TOKEN', { name: 'CUSTOM_TOKEN' });
    const result = await f.manager.ensure('CUSTOM_TOKEN', {
      repos: ['one'],
      acquire: () => {
        throw new Error('must not acquire');
      },
    });
    expect(result.changed).toBe(false);
    expect(f.calls.some((call) => call.method === 'PUT')).toBe(false);
  });
  it('rotates only an existing secret reported auth-failing', async () => {
    const f = await fixture();
    f.secrets.set('CUSTOM_TOKEN', { name: 'CUSTOM_TOKEN' });
    await f.manager.ensure('CUSTOM_TOKEN', {
      repos: ['one'],
      health: { status: 'auth-failing' },
      acquire: () => 'replacement',
    });
    expect(f.secrets.get('CUSTOM_TOKEN').value).toBe('replacement');
  });
  it('does not mask server failures with fallback writes', async () => {
    const f = await fixture(500);
    let failed = false;
    try {
      await f.manager.ensure('ANOTHER_NAME', { repos: ['one'] });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(f.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('uses repository storage when a known free plan cannot expose org secrets to private repositories', async () => {
    const f = await fixture();
    const send = f.rest.send;
    f.rest.request = async () => ({ plan: { name: 'free' } });
    f.rest.send = (path, options) =>
      path === '/repos/acme/one'
        ? Promise.resolve({
            status: 200,
            ok: true,
            body: { id: 11, private: true },
          })
        : send(path, options);
    const result = await ensureCustom(f.manager);
    expect(result.path).toBe('repository');
    expect(result.fallbackReason).toContain('plan');
    expect(result.results[0].verified).toBe(true);
  });

  it('does not fall back or revoke when companion metadata fails after a successful organization write', async () => {
    const f = await secretsApi();
    const send = f.rest.send;
    f.rest.send = (path, options) =>
      path.includes('/variables')
        ? Promise.resolve({ status: 403, ok: false })
        : send(path, options);
    const manager = createSecretManager({
      rest: f.rest,
      scope: { org: 'acme' },
      verificationTimeout: 0,
    });
    let failed = false;
    try {
      await manager.ensure('CUSTOM_TOKEN', {
        repos: ['one'],
        acquire: () => 'private-value',
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(f.secrets.has('CUSTOM_TOKEN')).toBe(true);
    expect(
      f.calls.some(
        (call) =>
          call.path.startsWith('/repos/') && call.path.includes('/actions')
      )
    ).toBe(false);
  });
});
