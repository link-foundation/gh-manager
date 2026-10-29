import { describe, it, expect } from 'test-anywhere';
import { apiCommand } from './fixtures/cli.js';
import { variablesApi } from './fixtures/variables-api.js';

const command = (args, api) =>
  apiCommand(['variable', ...args, '--json'], api, {
    openSession: () => {
      throw new Error('Variables do not need a browser');
    },
  });
describe('generic variable CLI', () => {
  it('ensures caller names and values, lists, gets effective state and deletes', async () => {
    const api = variablesApi({ base: '/repos/acme/one/actions' });
    const args = [
      'ensure',
      'NUGET_USER',
      '--value',
      'real-profile',
      '--repo',
      'acme/one',
    ];
    const first = await command(args, api);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.output).verified).toBe(true);
    expect(JSON.parse((await command(args, api)).output).changed).toBe(false);
    expect(
      JSON.parse(
        (
          await command(
            ['get', 'NUGET_USER', '--repo', 'acme/one', '--effective'],
            api
          )
        ).output
      ).value
    ).toBe('real-profile');
    expect(
      JSON.parse((await command(['list', '--repo', 'acme/one'], api)).output)
        .length
    ).toBe(1);
    expect(
      (
        await command(
          ['delete', 'NUGET_USER', '--repo', 'acme/one', '--yes'],
          api
        )
      ).code
    ).toBe(0);
  });
  it('supports organization selected grants, environments, empty values and dry runs', async () => {
    const api = variablesApi();
    expect(
      (
        await command(
          ['ensure', 'CUSTOM', '--value=', '--org', 'acme', '--repos', 'one'],
          api
        )
      ).code
    ).toBe(0);
    const env = await command(
      [
        'ensure',
        'CUSTOM',
        '--value',
        'v',
        '--repo',
        'acme/one',
        '--env',
        'prod',
        '--dry-run',
      ],
      api
    );
    expect(env.code).toBe(0);
    expect(JSON.parse(env.output).dryRun).toBe(true);
    expect(
      (await command(['ensure', 'CUSTOM', '--repo', 'acme/one'], api)).code
    ).toBe(2);
    expect(
      (await command(['list', '--org', 'acme', '--repo', 'acme/one'], api)).code
    ).toBe(2);
  });
  it('reports denial and effective-state mismatch with nonzero status', async () => {
    const denied = variablesApi({ denied: true });
    expect(
      (await command(['get', 'CUSTOM', '--repo', 'acme/one'], denied)).code
    ).toBe(3);
    const api = variablesApi();
    api
      .store('/repos/acme/one/actions')
      .set('CUSTOM', { name: 'CUSTOM', value: 'override' });
    expect(
      (
        await command(
          [
            'ensure',
            'CUSTOM',
            '--value',
            'org',
            '--org',
            'acme',
            '--repos',
            'one',
          ],
          api
        )
      ).code
    ).toBe(6);
  });
});
