/**
 * The CLI end to end, with a fake GitHub behind it.
 *
 * Each test executes a whole command line and asserts on what an operator
 * sees (the output), what a pipeline sees (the exit code), and what GitHub
 * ends up holding (the fixture state).
 */

import { describe, it, expect } from 'test-anywhere';

import { EXIT_CODES } from '../src/exit-codes.js';
import { fakeGitHub, runCommand } from './fixtures/cli-runner.js';

describe('gh-manager package list', () => {
  it('lists what the API reports', async () => {
    const github = fakeGitHub([
      { packageName: 'box', visibility: 'private' },
      { packageName: 'box-dind', visibility: 'public' },
    ]);

    const result = await runCommand(
      ['package', 'list', '--org', 'link-foundation'],
      {
        github,
      }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('box       private');
    expect(result.output).toContain('box-dind  public');
    expect(result.output).toContain('listed through the GitHub API');
    expect(result.sessions.length).toBe(0);
  });

  it('enumerates in the browser when the API listing is empty', async () => {
    const github = fakeGitHub(
      [{ packageName: 'box' }, { packageName: 'box-dind' }],
      {
        apiListing: false,
      }
    );

    const result = await runCommand(
      ['package', 'list', '--org', 'link-foundation'],
      {
        github,
      }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('box');
    expect(result.output).toContain(
      'enumerated in the browser, because the API returned no packages'
    );
    expect(result.sessions.length).toBe(1);
  });
});

describe('gh-manager package public', () => {
  it('flips every named package and verifies each change', async () => {
    const github = fakeGitHub([
      { packageName: 'box' },
      { packageName: 'box-dind' },
    ]);

    const result = await runCommand(
      ['package', 'public', 'box', 'box-dind', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(github.states.get('box').visibility).toBe('public');
    expect(github.states.get('box-dind').visibility).toBe('public');
    expect(result.output).toContain(
      'box is now public (verified through the api).'
    );
    expect(result.asked).toEqual([]);
  });

  it('reports a package that is already public without opening a browser', async () => {
    const github = fakeGitHub([{ packageName: 'box', visibility: 'public' }]);

    const result = await runCommand(
      ['package', 'public', 'box', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('box was already public.');
    expect(result.sessions.length).toBe(0);
  });

  it('asks before acting on a pattern, and lists what it resolved to', async () => {
    const github = fakeGitHub([
      { packageName: 'box' },
      { packageName: 'box-dind' },
      { packageName: 'gh-manager' },
    ]);

    const result = await runCommand(
      ['package', 'public', '--pattern', 'box*', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('Setting 2 package(s) to public:');
    expect(result.output).toContain('  - box');
    expect(result.output).toContain('  - box-dind');
    expect(result.asked).toEqual(['Proceed with 2 operation(s)?']);
    expect(github.states.get('gh-manager').visibility).toBe('private');
  });
});

describe('gh-manager package delete', () => {
  it('always asks, even for explicitly named packages', async () => {
    const github = fakeGitHub([{ packageName: 'box' }]);

    const result = await runCommand(
      ['package', 'delete', 'box', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.asked).toEqual(['Proceed with 1 operation(s)?']);
    expect(github.states.get('box').deleted).toBe(true);
    expect(result.output).toContain(
      'box was deleted (verified through the api).'
    );
  });

  it('changes nothing on a refused confirmation', async () => {
    const github = fakeGitHub([{ packageName: 'box' }]);

    const result = await runCommand(
      ['package', 'delete', 'box', '--org', 'link-foundation'],
      { github, confirm: () => false }
    );

    expect(result.code).toBe(EXIT_CODES.ABORTED);
    expect(github.states.get('box').deleted).toBe(false);
    expect(result.errors).toContain('Aborted: nothing was changed.');
  });

  it('shows the plan and stops for --dry-run, without asking', async () => {
    const github = fakeGitHub([
      { packageName: 'box' },
      { packageName: 'box-dind' },
    ]);

    const result = await runCommand(
      [
        'package',
        'delete',
        '--pattern',
        'box*',
        '--org',
        'link-foundation',
        '--dry-run',
      ],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('  - box');
    expect(result.output).toContain('  - box-dind');
    expect(result.output).toContain('Dry run: nothing was changed.');
    expect(result.asked).toEqual([]);
    expect(github.states.get('box').deleted).toBe(false);
  });

  it('refuses a pattern that matches nothing', async () => {
    const github = fakeGitHub([{ packageName: 'box' }]);

    const result = await runCommand(
      ['package', 'delete', '--pattern', 'nope*', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.NO_MATCHES);
    expect(result.errors).toContain(
      'Pattern "nope*" matched none of the 1 known package(s)'
    );
  });

  it('refuses a pattern that selects everything without --all', async () => {
    const github = fakeGitHub([{ packageName: 'box' }]);

    const result = await runCommand(
      ['package', 'delete', '--pattern', '*', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('pass --all to confirm');
    expect(github.states.get('box').deleted).toBe(false);
  });

  it('deletes what remains when one package fails', async () => {
    const github = fakeGitHub([
      { packageName: 'box' },
      { packageName: 'box-dind' },
    ]);
    // GitHub has no settings page for this name, so the first delete fails.
    github.states.set('ghost', { deleted: false, visibility: 'private' });

    const result = await runCommand(
      ['package', 'delete', 'ghost', 'box', '--org', 'link-foundation', '-y'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.FAILURE);
    expect(github.states.get('box').deleted).toBe(true);
    expect(result.errors).toContain('1 of 2 operation(s) failed.');
  });
});

describe('gh-manager usage', () => {
  it('prints the domains when asked for help', async () => {
    const result = await runCommand(['--help']);

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('gh-manager <domain> <verb>');
    expect(result.output).toContain('package');
    expect(result.output).toContain('permissions');
  });

  it('reports an unknown domain as a usage error', async () => {
    const result = await runCommand(['packages', 'list']);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('Unknown domain "packages"');
  });

  it('reports an unknown verb as a usage error', async () => {
    const result = await runCommand(['package', 'publicize', 'box']);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('Unknown verb "publicize"');
  });

  it('needs an account to act on', async () => {
    const github = fakeGitHub([{ packageName: 'box' }]);
    const result = await runCommand(['package', 'list'], { github });

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('gh-manager config set org');
  });
});
