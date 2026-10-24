import { describe, it, expect } from 'test-anywhere';
import { createPagesManager, pagesSource } from '../src/pages/manager.js';
import { runCommand } from './fixtures/cli-runner.js';
import { restClientFor } from './fixtures/fake-github-api.js';

export function pagesApi({ exists = true, ineffective = false } = {}) {
  let site = exists
    ? { build_type: 'legacy', source: { branch: 'main', path: '/' } }
    : null;
  const writes = [];
  const base = '/repos/acme/one/pages';
  const write = (request) => {
    writes.push(request);
    if (!ineffective) {
      site = request.body;
    }
    return { status: 201, body: site };
  };
  return {
    writes,
    rest: restClientFor({
      [base]: () =>
        site ? { status: 200, body: site } : { status: 404, body: {} },
      '/repos/acme/one': { status: 200, body: { full_name: 'acme/one' } },
      [`POST ${base}`]: write,
      [`PUT ${base}`]: write,
    }),
  };
}

describe('Pages source', () => {
  for (const exists of [true, false]) {
    it(`${exists ? 'updates' : 'creates'} an Actions site and verifies it`, async () => {
      const api = pagesApi({ exists });
      const result = await createPagesManager({
        rest: api.rest,
        verificationTimeout: 0,
      }).setSource('acme/one', { build_type: 'workflow' });
      expect(result.changed).toBe(true);
      expect(result.verifiedBy).toBe('api');
      expect(api.writes[0].method).toBe(exists ? 'PUT' : 'POST');
      expect(api.writes[0].body).toEqual({ build_type: 'workflow' });
    });
  }
  it('supports branch names with slashes and /docs paths', () => {
    expect(pagesSource({ branch: 'release/site:/docs' })).toEqual({
      build_type: 'legacy',
      source: { branch: 'release/site', path: '/docs' },
    });
  });
  it('rejects ambiguous or invalid sources', () => {
    for (const flags of [
      {},
      { actions: true, branch: 'main' },
      { branch: 'main:/bad' },
      { branch: ':/docs' },
    ]) {
      let error;
      try {
        pagesSource(flags);
      } catch (caught) {
        error = caught;
      }
      expect(Boolean(error)).toBe(true);
    }
  });
  it('is idempotent for the same branch source', async () => {
    const api = pagesApi();
    expect(
      (
        await createPagesManager({ rest: api.rest }).setSource(
          'acme/one',
          pagesSource({ branch: 'main' })
        )
      ).changed
    ).toBe(false);
    expect(api.writes.length).toBe(0);
  });
  it('fails when GitHub accepts a write without changing the source', async () => {
    const api = pagesApi({ ineffective: true });
    let error;
    try {
      await createPagesManager({
        rest: api.rest,
        verificationTimeout: 0,
      }).setSource('acme/one', { build_type: 'workflow' });
    } catch (caught) {
      error = caught;
    }
    expect(error.exitCode).toBe(6);
  });
  it('supports CLI JSON, confirmation, dry runs, status and --yes', async () => {
    const github = pagesApi();
    const dry = await runCommand(
      ['pages', 'source', 'acme/one', '--actions', '--dry-run', '--json'],
      { github }
    );
    expect(dry.code).toBe(0);
    expect(github.writes.length).toBe(0);
    const denied = await runCommand(
      ['pages', 'source', 'acme/one', '--actions'],
      { github, confirm: () => false }
    );
    expect(denied.code).toBe(5);
    expect(github.writes.length).toBe(0);
    const changed = await runCommand(
      ['pages', 'source', 'acme/one', '--actions', '--yes', '--json'],
      { github, realPrompt: true }
    );
    expect(changed.code).toBe(0);
    expect(JSON.parse(changed.output)[0].changed).toBe(true);
    const status = await runCommand(['pages', 'status', 'acme/one', '--json'], {
      github,
    });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.output)[0].build_type).toBe('workflow');
  });
});
