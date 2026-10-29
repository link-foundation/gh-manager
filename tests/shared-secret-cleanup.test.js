import { describe, it, expect } from 'test-anywhere';
import assert from 'node:assert/strict';
import { createSecretManager } from '../src/index.js';
import { secretsApi } from './fixtures/secrets-api.js';

async function fixture({
  used = false,
  unreadable = false,
  visibility = 'selected',
} = {}) {
  const api = await secretsApi();
  api.secrets.set('OLD', {
    name: 'OLD',
    visibility,
    selected_repository_ids: [11, 22],
  });
  const audited = [];
  const rest = {
    ...api.rest,
    request: async (path) => {
      audited.push(path);
      if (path.endsWith('/contents/.github/workflows')) {
        if (unreadable) {
          throw new Error('Denied');
        }
        return [{ type: 'file', name: 'ci.yml' }];
      }
      if (path.endsWith('/contents/.github/workflows/ci.yml')) {
        return {
          encoding: 'base64',
          content: Buffer.from(
            used && path.includes('/two/')
              ? 'token: ${{ secrets.OLD }}'
              : 'on: push'
          ).toString('base64'),
        };
      }
      if (path === '/orgs/acme') {
        return { public_repos: 1 };
      }
      if (path.startsWith('/orgs/acme/repos?')) {
        return [{ full_name: 'acme/one' }];
      }
      return api.rest.request(path);
    },
  };
  return {
    ...api,
    audited,
    manager: createSecretManager({
      rest,
      scope: { org: 'acme' },
      verificationTimeout: 0,
    }),
  };
}
describe('shared organization secret cleanup', () => {
  it('retains a secret when another selected repository still consumes it', async () => {
    const api = await fixture({ used: true });
    await assert.rejects(
      api.manager.cleanup(['OLD'], {
        reason: 'Caller verified replacement authentication',
        verify: () => true,
      }),
      /still has consumers/
    );
    expect(api.secrets.has('OLD')).toBe(true);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('retains secrets if consumer files or full organization inventory are unavailable', async () => {
    for (const options of [{ unreadable: true }, { visibility: 'all' }]) {
      const api = await fixture(options);
      await assert.rejects(
        api.manager.cleanup(['OLD'], {
          reason: 'Caller verification',
          verify: () => true,
        }),
        /incomplete|complete/
      );
      expect(api.secrets.has('OLD')).toBe(true);
    }
  });
  it('deletes only after caller verification and a complete audit of every selected consumer', async () => {
    const api = await fixture();
    const result = await api.manager.cleanup(['OLD'], {
      reason: 'OIDC publication and workflow consumers verified by caller',
      verify: () => true,
    });
    expect(result.verified).toBe(true);
    expect(result.audit.complete).toBe(true);
    expect(api.audited.some((path) => path.includes('/two/'))).toBe(true);
    expect(api.secrets.has('OLD')).toBe(false);
  });
});
