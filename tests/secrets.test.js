import { describe, it, expect } from 'test-anywhere';
import { createSecretManager } from '../src/secrets/manager.js';
import { secretsApi } from './fixtures/secrets-api.js';

const org = { org: 'acme' };
const TOKEN = 'fixture-token-value';
async function fixture(options = {}, scope = org) {
  const api = await secretsApi(options);
  return {
    ...api,
    manager: createSecretManager({
      rest: api.rest,
      scope,
      verificationTimeout: 0,
    }),
  };
}
async function failure(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected failure');
}

describe('Actions secrets API', () => {
  for (const [label, scope, base] of [
    ['organization', org, '/orgs/acme/actions'],
    [
      'repository',
      { repo: { owner: 'acme', name: 'one' } },
      '/repos/acme/one/actions',
    ],
    [
      'environment',
      { repo: { owner: 'acme', name: 'one' }, environment: 'prod/eu' },
      '/repos/acme/one/environments/prod%2Feu',
    ],
  ]) {
    it(`encrypts, reads metadata and verifies deletion at ${label} scope`, async () => {
      const f = await fixture({ base }, scope);
      const result = await f.manager.set('DOCKERHUB_TOKEN', TOKEN, {
        repos: ['one'],
      });
      expect(result.verified).toBe(true);
      expect(f.secrets.get('DOCKERHUB_TOKEN').value).toBe(TOKEN);
      expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
      const metadata = await f.manager.getMetadata('DOCKERHUB_TOKEN');
      expect(metadata.name).toBe('DOCKERHUB_TOKEN');
      expect(metadata.value).toBe(undefined);
      expect(await f.manager.list()).toEqual([metadata]);
      expect((await f.manager.delete('DOCKERHUB_TOKEN')).verified).toBe(true);
      expect(f.secrets.size).toBe(0);
    });
  }
  it('defaults organization grants to selected and resolves repository names to IDs', async () => {
    const f = await fixture();
    await f.manager.set('DOCKERHUB_TOKEN', TOKEN, {
      repos: ['one', 'acme/two'],
    });
    const write = f.calls.find((call) => call.method === 'PUT');
    expect(write.body.visibility).toBe('selected');
    expect(write.body.selected_repository_ids).toEqual([11, 22]);
    expect(
      (
        await f.manager.getMetadata('DOCKERHUB_TOKEN')
      ).selected_repositories.map((repo) => repo.id)
    ).toEqual([11, 22]);
  });
  it('paginates and filters organization metadata for a repository', async () => {
    const f = await fixture();
    for (let i = 0; i < 101; i++) {
      f.secrets.set(`S_${i}`, {
        name: `S_${i}`,
        visibility: i === 100 ? 'all' : 'selected',
        selected_repository_ids: [22],
      });
    }
    const items = await f.manager.list({ repo: 'one' });
    expect(items.map((item) => item.name)).toEqual(['S_100']);
    expect(f.calls.some((call) => call.path === `${f.base}/secrets`)).toBe(
      true
    );
  });
  it('makes dry-run plans without reading keys or accepting values in the plan', async () => {
    const f = await fixture();
    const result = await f.manager.set('DOCKERHUB_TOKEN', TOKEN, {
      repos: ['one'],
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(f.calls.length).toBe(0);
  });
  it('explains denied organization access without reporting absence', async () => {
    const f = await fixture({ denied: true });
    const error = await failure(() =>
      f.manager.ensure('DOCKERHUB_TOKEN', {
        acquire: () => TOKEN,
        repos: ['one'],
      })
    );
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain('admin:org');
    expect(error.message).toContain('gh auth refresh -s admin:org');
    expect(error.message).toContain(
      'https://github.com/organizations/acme/settings/secrets/actions'
    );
    expect(f.calls.length).toBe(1);
  });
  it('does not claim a write or deletion that cannot be verified', async () => {
    const f = await fixture({ ignoreWrites: true });
    expect(
      (
        await failure(() =>
          f.manager.set('DOCKERHUB_TOKEN', TOKEN, { repos: ['one'] })
        )
      ).exitCode
    ).toBe(6);
    f.secrets.set('OLD', { name: 'OLD' });
    expect((await failure(() => f.manager.delete('OLD'))).exitCode).toBe(6);
  });
  it('rejects storing publishing tokens for OIDC registries and unknown scopes', async () => {
    const f = await fixture();
    expect(
      (
        await failure(() =>
          f.manager.set('NPM_TOKEN', TOKEN, { repos: ['one'] })
        )
      ).message
    ).toContain('trusted publishing');
    expect(
      (
        await failure(() =>
          f.manager.set('TOKEN', TOKEN, {
            registry: 'crates.io',
            repos: ['one'],
          })
        )
      ).message
    ).toContain('never stored');
    expect(
      (
        await failure(() =>
          createSecretManager({ rest: f.rest, scope: { environment: 'prod' } })
        )
      ).exitCode
    ).toBe(2);
  });
});

describe('registry-driven ensure and expiry', () => {
  it('acquires an absent secret once and records matching expiry visibility', async () => {
    const f = await fixture();
    let acquired = 0;
    const result = await f.manager.ensure('DOCKERHUB_TOKEN', {
      repos: ['one'],
      acquire: () => {
        acquired++;
        return { value: TOKEN, expiresAt: '2099-01-01T00:00:00Z' };
      },
      validate: ({ value }) => ({ valid: value === TOKEN }),
    });
    expect(result.reason).toBe('absent');
    expect(acquired).toBe(1);
    expect(f.variables.get('DOCKERHUB_TOKEN_EXPIRES_AT').value).toBe(
      '2099-01-01T00:00:00.000Z'
    );
    expect(
      f.variables.get('DOCKERHUB_TOKEN_EXPIRES_AT').selected_repository_ids
    ).toEqual([11]);
  });
  it('keeps an existing valid token without reading a replacement', async () => {
    const f = await fixture();
    const name = 'DOCKERHUB_TOKEN';
    f.secrets.set(name, {
      name,
      visibility: 'private',
    });
    const result = await f.manager.ensure('DOCKERHUB_TOKEN', {
      validate: ({ metadata, value }) => {
        expect(value).toBe(undefined);
        expect(metadata.name).toBe('DOCKERHUB_TOKEN');
        return { valid: true };
      },
      acquire: () => {
        throw new Error('should not acquire');
      },
    });
    expect(result.changed).toBe(false);
  });
  for (const reason of ['expired', 'expiring', 'invalid']) {
    it(`rotates a ${reason} token and removes stale expiry when replacement has none`, async () => {
      const f = await fixture();
      f.secrets.set('DOCKERHUB_TOKEN', {
        name: 'DOCKERHUB_TOKEN',
        visibility: 'private',
      });
      f.variables.set('DOCKERHUB_TOKEN_EXPIRES_AT', {
        name: 'DOCKERHUB_TOKEN_EXPIRES_AT',
        value:
          reason === 'expired'
            ? '2000-01-01T00:00:00Z'
            : reason === 'expiring'
              ? new Date(Date.now() + 1000).toISOString()
              : '2099-01-01T00:00:00Z',
      });
      const result = await f.manager.ensure('DOCKERHUB_TOKEN', {
        validate: ({ value }) => ({
          valid: value ? true : reason !== 'invalid',
        }),
        acquire: () => TOKEN,
      });
      expect(result.reason).toBe(reason);
      expect(f.secrets.get('DOCKERHUB_TOKEN').value).toBe(TOKEN);
      expect(f.variables.size).toBe(0);
    });
  }
  it('refuses to guess validity when neither expiry nor a validator is available', async () => {
    const f = await fixture();
    f.secrets.set('DOCKERHUB_TOKEN', { name: 'DOCKERHUB_TOKEN' });
    expect(
      (
        await failure(() =>
          f.manager.ensure('DOCKERHUB_TOKEN', { acquire: () => TOKEN })
        )
      ).message
    ).toContain('validity is unknown');
  });
  it('redacts registry callback failures even when the callback includes the token', async () => {
    const f = await fixture();
    const error = await failure(() =>
      f.manager.ensure('DOCKERHUB_TOKEN', {
        repos: ['one'],
        acquire: () => ({ value: TOKEN }),
        validate: () => {
          throw new Error(TOKEN);
        },
      })
    );
    expect(error.stack).not.toContain(TOKEN);
    expect(error.cause).toBe(undefined);
    expect(f.secrets.size).toBe(0);
  });
  it('does not acquire or validate token values during a dry run', async () => {
    const f = await fixture();
    const result = await f.manager.ensure('DOCKERHUB_TOKEN', {
      dryRun: true,
      repos: ['one'],
      acquire: () => {
        throw new Error(TOKEN);
      },
      validate: () => {
        throw new Error(TOKEN);
      },
    });
    expect(result.dryRun).toBe(true);
    expect(result.reason).toBe('absent');
    expect(f.secrets.size).toBe(0);
  });
});

describe('verified rotation and trusted publishing cleanup', () => {
  it('rejects expiry variables whose repository grants do not match the secret', async () => {
    const f = await fixture();
    const send = f.rest.send;
    f.rest.send = async (path, options) =>
      path.includes('/variables/TOKEN_EXPIRES_AT/repositories')
        ? { status: 200, ok: true, body: { repositories: [] } }
        : send(path, options);
    const error = await failure(() =>
      f.manager.set('TOKEN', TOKEN, {
        repos: ['one'],
        expiresAt: '2099-01-01T00:00:00Z',
      })
    );
    expect(error.exitCode).toBe(6);
  });
  it('checks collection access before acquiring a token after an individual 404', async () => {
    const f = await fixture();
    const send = f.rest.send;
    f.rest.send = async (path, options) =>
      path.includes('/secrets?')
        ? { status: 403, ok: false }
        : send(path, options);
    let acquired = false;
    const error = await failure(() =>
      f.manager.ensure('TOKEN', {
        repos: ['one'],
        acquire: () => {
          acquired = true;
          return TOKEN;
        },
      })
    );
    expect(error.exitCode).toBe(3);
    expect(acquired).toBe(false);
  });
  it('records expiry supplied by a validator without acquiring a replacement', async () => {
    const f = await fixture();
    f.secrets.set('TOKEN', { name: 'TOKEN', visibility: 'private' });
    const result = await f.manager.ensure('TOKEN', {
      validate: () => ({ valid: true, expiresAt: '2099-01-01T00:00:00Z' }),
    });
    expect(result.changed).toBe(false);
    expect(f.variables.get('TOKEN_EXPIRES_AT').value).toBe(
      '2099-01-01T00:00:00.000Z'
    );
  });
  it('revokes the previous token only after storage and expiry verification', async () => {
    const f = await fixture();
    f.secrets.set('TOKEN', { name: 'TOKEN', visibility: 'private' });
    let revoked = false;
    await f.manager.ensure('TOKEN', {
      acquire: () => ({ value: TOKEN, expiresAt: '2099-01-01T00:00:00Z' }),
      validate: ({ value }) => ({ valid: value === TOKEN }),
      revokePrevious: () => {
        expect(f.secrets.get('TOKEN').value).toBe(TOKEN);
        expect(f.variables.has('TOKEN_EXPIRES_AT')).toBe(true);
        revoked = true;
      },
    });
    expect(revoked).toBe(true);
  });
  it('keeps old registry credentials when expiry storage fails after the secret is written', async () => {
    const f = await fixture();
    f.secrets.set('TOKEN', { name: 'TOKEN', visibility: 'private' });
    const send = f.rest.send;
    f.rest.send = async (path, options) =>
      path.includes('/variables') && options?.method === 'POST'
        ? { status: 403, ok: false }
        : send(path, options);
    let revoked = false;
    const error = await failure(() =>
      f.manager.ensure('TOKEN', {
        validate: ({ value }) => ({ valid: value === TOKEN }),
        acquire: () => ({ value: TOKEN, expiresAt: '2099-01-01T00:00:00Z' }),
        revokePrevious: () => {
          revoked = true;
        },
      })
    );
    expect(error.exitCode).toBe(3);
    expect(revoked).toBe(false);
    expect(f.secrets.get('TOKEN').value).toBe(TOKEN);
  });
  it('cleans up legacy secrets only after trusted publishing is verified', async () => {
    const f = await fixture();
    f.secrets.set('NPM_TOKEN', { name: 'NPM_TOKEN' });
    expect(
      (
        await failure(() =>
          f.manager.cleanup('npm', { verifyTrustedPublishing: () => false })
        )
      ).message
    ).toContain('not verified');
    expect(f.secrets.size).toBe(1);
    await f.manager.cleanup('npm', { verifyTrustedPublishing: () => true });
    expect(f.secrets.size).toBe(0);
  });
});
