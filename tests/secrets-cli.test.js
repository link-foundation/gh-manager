import { describe, it, expect } from 'test-anywhere';
import { apiCommand } from './fixtures/cli.js';
import { secretsApi } from './fixtures/secrets-api.js';

async function command(args, options = {}) {
  const api = options.api ?? (await secretsApi());
  let reads = 0;
  const result = await apiCommand(['secret', ...args], api, {
    readSecret: async () => {
      reads++;
      return 'private-value\n';
    },
    ...options.deps,
  });
  return { ...api, ...result, reads };
}

describe('secret CLI', () => {
  it('accepts a value only from stdin, encrypts it and prints only metadata', async () => {
    const result = await command([
      'set',
      'DOCKERHUB_TOKEN',
      '--org',
      'acme',
      '--repos',
      'one',
      '--json',
      '--verbose',
    ]);
    expect(result.code).toBe(0);
    expect(result.reads).toBe(1);
    expect(result.secrets.get('DOCKERHUB_TOKEN').value).toBe('private-value');
    expect(result.output + result.errors).not.toContain('private-value');
  });
  it('rejects positional values and value flags without echoing credentials', async () => {
    const result = await command([
      'set',
      'DOCKERHUB_TOKEN',
      'private-value',
      '--org',
      'acme',
    ]);
    expect(result.code).toBe(2);
    expect(result.errors).not.toContain('private-value');
    expect(result.reads).toBe(0);
  });
  it('does not read stdin or mutate the API in dry runs', async () => {
    const result = await command([
      'set',
      'DOCKERHUB_TOKEN',
      '--org',
      'acme',
      '--repos',
      'one',
      '--dry-run',
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('dryRun');
    expect(result.reads).toBe(0);
    expect(result.calls.length).toBe(0);
  });
  it('lists organization secrets filtered to a repository', async () => {
    const api = await secretsApi();
    api.secrets.set('TOKEN', {
      name: 'TOKEN',
      visibility: 'all',
      updated_at: 'fixture-timestamp',
    });
    const result = await command(
      ['list', '--org', 'acme', '--repo', 'one', '--json'],
      { api }
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)[0].name).toBe('TOKEN');
  });
  it('does not consume stdin for an existing secret with a future expiry', async () => {
    const api = await secretsApi();
    api.secrets.set('TOKEN', { name: 'TOKEN', visibility: 'private' });
    api.variables.set('TOKEN_EXPIRES_AT', {
      name: 'TOKEN_EXPIRES_AT',
      value: '2099-01-01T00:00:00Z',
    });
    const result = await command(['ensure', 'TOKEN', '--org', 'acme'], { api });
    expect(result.code).toBe(0);
    expect(result.reads).toBe(0);
    expect(result.output).toContain('valid');
  });
  it('uses repository and environment scope with an explicit target', async () => {
    const api = await secretsApi({ base: '/repos/acme/one/environments/prod' });
    const result = await command(
      ['set', 'TOKEN', '--repo', 'acme/one', '--env', 'prod'],
      { api }
    );
    expect(result.code).toBe(0);
    expect(result.secrets.get('TOKEN').value).toBe('private-value');
    expect(result.calls.every((call) => call.path.startsWith(api.base))).toBe(
      true
    );
  });
  it('reports permission recovery with a failing exit code', async () => {
    const result = await command(['list', '--org', 'acme'], {
      api: await secretsApi({ denied: true }),
    });
    expect(result.code).toBe(3);
    expect(result.errors).toContain('gh auth refresh -s admin:org');
  });
  it('prints a GitHub App setup plan without reading a private key', async () => {
    const result = await command(['setup-app', '--org', 'acme', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('actions/create-github-app-token');
    expect(result.output).toContain('APP_PRIVATE_KEY');
    expect(result.reads).toBe(0);
  });
});
