/**
 * The CLI end to end, with a fake GitHub behind it.
 *
 * `runCli` returns an exit code, so a whole command line can be executed in
 * process: the arguments are parsed, the real gateway and the real page
 * drivers run, and the assertions cover what an operator sees (the output),
 * what a pipeline sees (the exit code), and what GitHub ends up holding (the
 * fixture state).
 */

import { describe, it, expect } from 'test-anywhere';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES } from '../src/exit-codes.js';
import { runCli } from '../src/cli/main.js';
import { createFakeSession } from './fixtures/fake-browser.js';
import { listingRoutes, packagePages } from './fixtures/github-pages.js';

/**
 * Build a GitHub whose API and pages describe the same packages.
 *
 * The API reads from the state the page drivers change, which is what makes a
 * verified change meaningful here: the visibility the CLI reports has to be
 * the one the browser actually produced.
 * @param {Array<{name: string, visibility?: string}>} specs - Packages to serve
 * @param {Object} [options] - GitHub options
 * @param {boolean} [options.apiListing] - Whether the REST listing answers
 * @param {boolean} [options.hasToken] - Whether a token is configured
 * @returns {Object} REST client, browser routes, and the fixture state
 */
function fakeGitHub(specs, { apiListing = true, hasToken = true } = {}) {
  const pages = specs.map((spec) =>
    packagePages({
      packageName: spec.name,
      visibility: spec.visibility ?? 'private',
    })
  );
  const states = new Map(
    specs.map((spec, index) => [spec.name, pages[index].state])
  );

  const routes = Object.assign(
    {},
    ...pages.map((entry) => entry.routes),
    listingRoutes([specs.map((spec) => spec.name)])
  );

  /**
   * Read the packages the API can currently see.
   * @returns {Array<Object>} Package payloads
   */
  function live() {
    return [...states]
      .filter(([, state]) => !state.deleted)
      .map(([name, state]) => ({ name, visibility: state.visibility }));
  }

  const rest = {
    hasToken,
    /**
     * @returns {Promise<Array<Object>>} Packages, or nothing when the listing
     *   endpoint answers empty for this token
     */
    async listPackages() {
      return apiListing && hasToken ? live() : [];
    },
    /**
     * @param {Object} options - Coordinates
     * @param {string} options.packageName - Package name
     * @returns {Promise<Object|null>} Package payload, or null when gone
     */
    async getPackage({ packageName }) {
      if (!hasToken) {
        return null;
      }

      return live().find((entry) => entry.name === packageName) ?? null;
    },
  };

  return { rest, routes, states };
}

/**
 * Run one command line against a fake GitHub.
 * @param {string[]} argv - Command line, without the executable
 * @param {Object} [options] - Run options
 * @param {Object} [options.github] - Result of fakeGitHub
 * @param {Function} [options.confirm] - Confirmation stand-in
 * @returns {Promise<Object>} Exit code, output lines, and the sessions opened
 */
async function run(argv, { github, confirm } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gh-manager-cli-'));
  const out = [];
  const err = [];
  const sessions = [];
  const asked = [];

  try {
    const code = await runCli(argv, {
      stdout: (line) => out.push(String(line)),
      stderr: (line) => err.push(String(line)),
      env: {},
      home,
      deps: {
        resolveToken: () => ({
          token: github?.rest.hasToken === false ? null : 'test-token',
          source: '--token',
        }),
        createRest: () => github?.rest,
        openSession: async () => {
          const session = createFakeSession({ routes: github?.routes ?? {} });
          sessions.push(session);
          return session;
        },
        confirm: async (question) => {
          asked.push(question);
          return confirm ? confirm(question) : true;
        },
      },
    });

    return { code, out, err, sessions, asked, output: out.join('\n') };
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

describe('gh-manager package list', () => {
  it('lists what the API reports', async () => {
    const github = fakeGitHub([
      { name: 'box', visibility: 'private' },
      { name: 'box-dind', visibility: 'public' },
    ]);

    const result = await run(['package', 'list', '--org', 'link-foundation'], {
      github,
    });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('box       private');
    expect(result.output).toContain('box-dind  public');
    expect(result.output).toContain('listed through the GitHub API');
    expect(result.sessions.length).toBe(0);
  });

  it('enumerates in the browser when the API listing is empty', async () => {
    const github = fakeGitHub([{ name: 'box' }, { name: 'box-dind' }], {
      apiListing: false,
    });

    const result = await run(['package', 'list', '--org', 'link-foundation'], {
      github,
    });

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
    const github = fakeGitHub([{ name: 'box' }, { name: 'box-dind' }]);

    const result = await run(
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
    const github = fakeGitHub([{ name: 'box', visibility: 'public' }]);

    const result = await run(
      ['package', 'public', 'box', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('box was already public.');
    expect(result.sessions.length).toBe(0);
  });

  it('asks before acting on a pattern, and lists what it resolved to', async () => {
    const github = fakeGitHub([
      { name: 'box' },
      { name: 'box-dind' },
      { name: 'gh-manager' },
    ]);

    const result = await run(
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
    const github = fakeGitHub([{ name: 'box' }]);

    const result = await run(
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
    const github = fakeGitHub([{ name: 'box' }]);

    const result = await run(
      ['package', 'delete', 'box', '--org', 'link-foundation'],
      { github, confirm: () => false }
    );

    expect(result.code).toBe(EXIT_CODES.ABORTED);
    expect(github.states.get('box').deleted).toBe(false);
    expect(result.err.join('\n')).toContain('Aborted: nothing was changed.');
  });

  it('shows the plan and stops for --dry-run, without asking', async () => {
    const github = fakeGitHub([{ name: 'box' }, { name: 'box-dind' }]);

    const result = await run(
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
    const github = fakeGitHub([{ name: 'box' }]);

    const result = await run(
      ['package', 'delete', '--pattern', 'nope*', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.NO_MATCHES);
    expect(result.err.join('\n')).toContain(
      'Pattern "nope*" matched none of the 1 known package(s)'
    );
  });

  it('refuses a pattern that selects everything without --all', async () => {
    const github = fakeGitHub([{ name: 'box' }]);

    const result = await run(
      ['package', 'delete', '--pattern', '*', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.err.join('\n')).toContain('pass --all to confirm');
    expect(github.states.get('box').deleted).toBe(false);
  });

  it('deletes what remains when one package fails', async () => {
    const github = fakeGitHub([{ name: 'box' }, { name: 'box-dind' }]);
    // GitHub has no settings page for this name, so the first delete fails.
    github.states.set('ghost', { deleted: false, visibility: 'private' });

    const result = await run(
      ['package', 'delete', 'ghost', 'box', '--org', 'link-foundation', '-y'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.FAILURE);
    expect(github.states.get('box').deleted).toBe(true);
    expect(result.err.join('\n')).toContain('1 of 2 operation(s) failed.');
  });
});

describe('gh-manager usage', () => {
  it('prints the domains when asked for help', async () => {
    const result = await run(['--help']);

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('gh-manager <domain> <verb>');
    expect(result.output).toContain('package');
    expect(result.output).toContain('permissions');
  });

  it('reports an unknown domain as a usage error', async () => {
    const result = await run(['packages', 'list']);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.err.join('\n')).toContain('Unknown domain "packages"');
  });

  it('reports an unknown verb as a usage error', async () => {
    const result = await run(['package', 'publicize', 'box']);

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.err.join('\n')).toContain('Unknown verb "publicize"');
  });

  it('needs an account to act on', async () => {
    const github = fakeGitHub([{ name: 'box' }]);
    const result = await run(['package', 'list'], { github });

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.err.join('\n')).toContain('gh-manager config set org');
  });
});
