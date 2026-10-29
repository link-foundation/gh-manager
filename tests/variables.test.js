import { describe, it, expect } from 'test-anywhere';
import assert from 'node:assert/strict';
import { createVariableManager } from '../src/index.js';
import { variablesApi } from './fixtures/variables-api.js';

const repo = { owner: 'acme', name: 'one' };
const manager = (api, scope = { repo }) =>
  createVariableManager({ rest: api.rest, scope, verificationTimeout: 0 });

describe('caller-named Actions variables', () => {
  it('creates, reads, lists, updates and deletes repository variables with verified no-ops', async () => {
    const api = await variablesApi({ base: '/repos/acme/one/actions' });
    const variables = manager(api);
    const created = await variables.ensure('custom_user', 'profile');
    expect(created.changed).toBe(true);
    expect(created.verified).toBe(true);
    expect((await variables.get('CUSTOM_USER')).value).toBe('profile');
    expect((await variables.list()).length).toBe(1);
    const writes = api.calls.filter((call) => call.method !== 'GET').length;
    const again = await variables.ensure('CUSTOM_USER', 'profile');
    expect(again.changed).toBe(false);
    expect(again.verified).toBe(true);
    expect(api.calls.filter((call) => call.method !== 'GET').length).toBe(
      writes
    );
    await variables.ensure('CUSTOM_USER', 'another');
    expect((await variables.delete('CUSTOM_USER')).verified).toBe(true);
    expect(await variables.get('CUSTOM_USER')).toBe(null);
    expect((await variables.delete('CUSTOM_USER')).changed).toBe(false);
  });
  it('preserves selected organization repositories when changing a value', async () => {
    const api = await variablesApi();
    api.variables.set('CUSTOM', {
      name: 'CUSTOM',
      value: 'old',
      visibility: 'selected',
      selected_repository_ids: [11, 22],
    });
    const result = await manager(api, { org: 'acme' }).ensure('CUSTOM', 'new');
    expect(result.verified).toBe(true);
    expect(api.variables.get('CUSTOM').selected_repository_ids).toEqual([
      11, 22,
    ]);
    expect(api.variables.get('CUSTOM').visibility).toBe('selected');
  });
  it('supports encoded environment names and dry-run with no writes', async () => {
    const api = await variablesApi({
      base: '/repos/acme/one/environments/production%2Fwest',
    });
    const variables = manager(api, { repo, environment: 'production/west' });
    expect(
      (await variables.ensure('CUSTOM', 'v', { dryRun: true })).verified
    ).toBe(false);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
    expect((await variables.ensure('CUSTOM', 'v')).verified).toBe(true);
  });
  it('reports denied access and read-back mismatch without pretending success', async () => {
    const denied = await variablesApi({ denied: true });
    await assert.rejects(
      manager(denied, { org: 'acme' }).ensure('CUSTOM', 'v'),
      /Variables/
    );
    expect(denied.calls.every((call) => call.method === 'GET')).toBe(true);
    const ignored = await variablesApi({
      base: '/repos/acme/one/actions',
      ignoreWrites: true,
    });
    await assert.rejects(manager(ignored).ensure('CUSTOM', 'v'), /confirm/);
  });
});

describe('effective variable state and API refusal', () => {
  it('resolves environment over repository over applicable organization values', async () => {
    const api = variablesApi();
    api.store('/orgs/acme/actions').set('CUSTOM', {
      name: 'CUSTOM',
      value: 'org',
      visibility: 'selected',
      selected_repository_ids: [11],
    });
    api
      .store('/repos/acme/one/actions')
      .set('CUSTOM', { name: 'CUSTOM', value: 'repo' });
    api
      .store('/repos/acme/one/environments/prod')
      .set('CUSTOM', { name: 'CUSTOM', value: 'env' });
    const variables = manager(api, { org: 'acme' });
    const result = await variables.ensure('CUSTOM', 'org', {
      contexts: [{ repo, environment: 'prod' }],
    });
    expect(result.changed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.effective[0].value).toBe('env');
    expect(result.effective[0].candidates.map((entry) => entry.value)).toEqual([
      'org',
      'repo',
      'env',
    ]);
    api.store('/repos/acme/one/environments/prod').delete('CUSTOM');
    expect(
      (await variables.effective('CUSTOM', { repo, environment: 'prod' })).value
    ).toBe('repo');
    api.store('/repos/acme/one/actions').delete('CUSTOM');
    expect((await variables.effective('CUSTOM', { repo })).value).toBe('org');
    api.store('/orgs/acme/actions').get('CUSTOM').selected_repository_ids = [
      22,
    ];
    expect((await variables.effective('CUSTOM', { repo })).value).toBe(null);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('adds explicit selected grants while preserving other consumers and refuses widening', async () => {
    const api = variablesApi();
    api.variables.set('CUSTOM', {
      name: 'CUSTOM',
      value: 'v',
      visibility: 'selected',
      selected_repository_ids: [22],
    });
    const variables = manager(api, { org: 'acme' });
    expect(
      (await variables.ensure('CUSTOM', 'v', { repos: ['one'] })).verified
    ).toBe(true);
    expect(api.variables.get('CUSTOM').selected_repository_ids).toEqual([
      11, 22,
    ]);
    await assert.rejects(
      variables.ensure('CUSTOM', 'v', { visibility: 'all' }),
      /preserves/
    );
  });
  for (const status of [401, 403, 404, 409, 422]) {
    it(`reports HTTP ${status} writes without fallback or access widening`, async () => {
      const api = variablesApi({ writeStatus: status });
      await assert.rejects(
        manager(api, { org: 'acme' }).ensure('CUSTOM', 'v', { repos: ['one'] }),
        (error) => error.status === status
      );
      expect(api.variables.size).toBe(0);
      expect(api.calls.filter((call) => call.method !== 'GET').length).toBe(1);
      expect(api.calls.at(-1).body.visibility).toBe('selected');
    });
  }
  it('distinguishes inaccessible inventory from an individual missing variable', async () => {
    const api = {
      rest: { hasToken: true, send: async () => ({ ok: false, status: 404 }) },
    };
    await assert.rejects(
      manager(api).get('MISSING'),
      (error) => error.status === 404
    );
  });
  it('reports the permission for the failing endpoint when effective checks cross scopes', async () => {
    const denied = {
      rest: { hasToken: true, send: async () => ({ ok: false, status: 403 }) },
    };
    for (const scope of [{ org: 'acme' }, { repo, environment: 'prod' }]) {
      await assert.rejects(
        manager(denied, scope).effective('CUSTOM', { repo }),
        /Variables repository permission/
      );
    }
    await assert.rejects(
      manager(denied, { repo, environment: 'prod' }).get('CUSTOM'),
      /Environments repository permission/
    );
  });
  it('paginates inventories and rejects invalid names, scopes and values', async () => {
    const api = variablesApi({ base: '/repos/acme/one/actions' });
    for (let i = 0; i < 101; i++) {
      api.variables.set(`V${i}`, { name: `V${i}`, value: '' });
    }
    expect((await manager(api).list()).length).toBe(101);
    for (const name of ['GITHUB_TOKEN', '0INVALID', 'x/y', '']) {
      await assert.rejects(manager(api).ensure(name, 'v'));
    }
    await assert.rejects(manager(api).ensure('CUSTOM', 1));
    await assert.rejects(
      manager(api).ensure('CUSTOM', 'v'.repeat(48 * 1024 + 1))
    );
    assert.throws(() => manager(api, { org: 'acme', repo }));
    assert.throws(() => manager(api, { repo, environment: '..' }));
    const preview = await manager(api).delete('V0', { dryRun: true });
    expect(preview.verified).toBe(false);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
