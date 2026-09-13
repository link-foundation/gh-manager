/**
 * The `security` domain end to end, with a fake GitHub behind it.
 *
 * Each test runs a whole command line through the shipped parser, gateway, and
 * page drivers, and then asserts on the three things that matter to whoever
 * runs it: the exit code a pipeline reads, the lines an operator reads, and the
 * state GitHub is left holding. The last one is what keeps a reported change
 * honest — the fixture's API answers from the state its settings page carries,
 * so a command can only claim a toggle is on if something actually turned it on.
 */

import { describe, it, expect } from 'test-anywhere';

import { EXIT_CODES } from '../src/exit-codes.js';
import { runCommand } from './fixtures/cli-runner.js';
import { securityGitHub } from './fixtures/github-security-pages.js';

const REPO = 'link-foundation/gh-manager';

/**
 * Run one `gh-manager security` command line.
 * @param {string[]} argv - Arguments after `security`
 * @param {Object} [options] - Run options, passed on to runCommand
 * @returns {Promise<Object>} Run result
 */
function run(argv, options = {}) {
  return runCommand(['security', ...argv], options);
}

describe('gh-manager security status', () => {
  it('reports every toggle from the API without opening a browser', async () => {
    const github = securityGitHub({
      states: {
        'vulnerability-alerts': 'enabled',
        'secret-scanning': 'enabled',
      },
    });

    const result = await run(['status', REPO], { github });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain(REPO);
    expect(result.output).toContain('dependency-graph          disabled');
    expect(result.output).toContain('vulnerability-alerts      enabled');
    expect(result.output).toContain('secret-scanning           enabled');
    expect(result.sessions.length).toBe(0);
  });

  it('reads the settings page when the token may not ask, and says where the answer came from', async () => {
    const github = securityGitHub({
      apiRead: false,
      states: { 'dependency-graph': 'enabled' },
    });

    const result = await run(['status', REPO], { github });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('dependency-graph          enabled');
    expect(result.output).toContain('(read from the settings page)');
    // One page reading answers for every feature, so the browser opens the
    // settings page a single time for the whole listing.
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].visited.length).toBe(1);
  });

  it('emits one machine readable entry per repository under --json', async () => {
    const github = securityGitHub({ states: { 'push-protection': 'enabled' } });

    const result = await run(['status', REPO, '--json'], { github });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);

    const report = JSON.parse(result.output);

    expect(report.length).toBe(1);
    expect(report[0].repository).toBe(REPO);
    expect(report[0].features.map((feature) => feature.id)).toEqual([
      'dependency-graph',
      'vulnerability-alerts',
      'automated-security-fixes',
      'secret-scanning',
      'push-protection',
    ]);
    expect(report[0].features[4]).toEqual({
      id: 'push-protection',
      label: 'Push protection',
      state: 'enabled',
      source: 'api',
    });
  });
});

describe('gh-manager security dependency-graph', () => {
  it('flips the toggle in the browser and proves it with the SBOM', async () => {
    const github = securityGitHub();

    const result = await run(['dependency-graph', REPO, '--enable'], {
      github,
    });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(github.state.features['dependency-graph']).toBe('enabled');
    expect(github.state.clicks).toEqual([
      { feature: 'dependency-graph', action: 'enable' },
    ]);
    expect(result.output).toContain(
      `${REPO}: "Dependency graph" is now enabled, set through the browser and verified through the api.`
    );
    // No endpoint writes this toggle, so nothing but the click could have
    // moved it, and only the SBOM can confirm that it did.
    expect(github.state.writes).toEqual([]);
  });

  it('asks before changing anything, and changes nothing when the answer is no', async () => {
    const github = securityGitHub();

    const result = await run(['dependency-graph', REPO, '--enable'], {
      github,
      confirm: () => false,
    });

    expect(result.code).toBe(EXIT_CODES.ABORTED);
    expect(result.asked).toEqual(['Proceed with 1 operation(s)?']);
    expect(github.state.features['dependency-graph']).toBe('disabled');
    expect(github.state.clicks).toEqual([]);
  });

  it('accepts --yes in place of the prompt', async () => {
    const github = securityGitHub();

    const result = await run(['dependency-graph', REPO, '--enable', '--yes'], {
      github,
      realPrompt: true,
    });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(github.state.features['dependency-graph']).toBe('enabled');
  });

  it('shows the plan under --dry-run and touches nothing', async () => {
    const github = securityGitHub();

    const result = await run(
      ['dependency-graph', REPO, '--enable', '--dry-run'],
      {
        github,
      }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain(
      'Enabling "Dependency graph" on 1 repository(ies):'
    );
    expect(result.output).toContain(`  - ${REPO}`);
    expect(result.output).toContain('Dry run: nothing was changed.');
    expect(result.asked).toEqual([]);
    expect(result.sessions.length).toBe(0);
    expect(github.state.features['dependency-graph']).toBe('disabled');
  });

  it('fails loudly, with artifacts, when a policy owns the toggle', async () => {
    const github = securityGitHub({ locked: ['dependency-graph'] });

    const result = await run(['dependency-graph', REPO, '--enable'], {
      github,
    });

    expect(result.code).toBe(EXIT_CODES.FAILURE);
    expect(result.errors).toContain(
      'governed by an organization or enterprise policy'
    );
    expect(result.errors).toContain('/logs/enable Dependency graph');
    expect(result.sessions[0].captures).toEqual([
      `enable Dependency graph on ${REPO}`,
    ]);
    expect(github.state.clicks).toEqual([]);
    expect(github.state.features['dependency-graph']).toBe('disabled');
  });
});

describe('gh-manager security vulnerability-alerts', () => {
  it('writes through the API, and leaves the browser closed', async () => {
    const github = securityGitHub();

    const result = await run(['vulnerability-alerts', REPO, '--enable'], {
      github,
    });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(github.state.features['vulnerability-alerts']).toBe('enabled');
    expect(github.state.writes.map((write) => write.method)).toEqual(['PUT']);
    expect(result.output).toContain(
      'is now enabled, set through the api and verified through the api.'
    );
    expect(result.sessions.length).toBe(0);
  });

  it('falls back to the browser when the API refuses the write', async () => {
    const github = securityGitHub({ apiWrite: false });

    const result = await run(['vulnerability-alerts', REPO, '--enable'], {
      github,
    });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(github.state.features['vulnerability-alerts']).toBe('enabled');
    expect(github.state.clicks).toEqual([
      { feature: 'vulnerability-alerts', action: 'enable' },
    ]);
    expect(result.output).toContain(
      'is now enabled, set through the browser and verified through the api.'
    );
    expect(result.sessions.length).toBe(1);
  });

  it('turns the toggle off again', async () => {
    const github = securityGitHub({
      states: { 'vulnerability-alerts': 'enabled' },
    });

    const result = await run(['vulnerability-alerts', REPO, '--disable'], {
      github,
    });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(github.state.features['vulnerability-alerts']).toBe('disabled');
    expect(github.state.writes.map((write) => write.method)).toEqual([
      'DELETE',
    ]);
  });

  it('succeeds without acting when the toggle already has the wanted state', async () => {
    const github = securityGitHub({
      states: { 'vulnerability-alerts': 'enabled' },
    });

    const result = await run(['vulnerability-alerts', REPO, '--enable'], {
      github,
    });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain(
      `${REPO}: "Dependabot alerts" was already enabled.`
    );
    expect(github.state.writes).toEqual([]);
    expect(result.sessions.length).toBe(0);
  });

  it('tells a script under --json whether the run changed anything', async () => {
    const github = securityGitHub({
      states: { 'vulnerability-alerts': 'enabled' },
    });

    const result = await run(
      ['vulnerability-alerts', REPO, '--enable', '--json'],
      {
        github,
      }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(JSON.parse(result.output)).toEqual([
      {
        target: REPO,
        ok: true,
        feature: 'vulnerability-alerts',
        state: 'enabled',
        changed: false,
        changedBy: null,
        verifiedBy: 'api',
      },
    ]);
  });
});

describe('gh-manager security push-protection', () => {
  it('names the prerequisite and submits nothing GitHub would reject', async () => {
    const github = securityGitHub();

    const result = await run(['push-protection', REPO, '--enable'], { github });

    expect(result.code).toBe(EXIT_CODES.FAILURE);
    expect(result.errors).toContain(
      `Run \`gh-manager security secret-scanning ${REPO} --enable\` first.`
    );
    expect(github.state.writes).toEqual([]);
    expect(github.state.clicks).toEqual([]);
  });

  it('goes through when secret scanning is already on', async () => {
    const github = securityGitHub({ states: { 'secret-scanning': 'enabled' } });

    const result = await run(['push-protection', REPO, '--enable'], { github });

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(github.state.features['push-protection']).toBe('enabled');
    expect(github.state.writes.map((write) => write.method)).toEqual(['PATCH']);
  });
});

describe('gh-manager security usage errors', () => {
  it('refuses a change that does not say which way to set the toggle', async () => {
    const github = securityGitHub();

    const result = await run(['dependency-graph', REPO], { github });

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('--enable');
    expect(result.errors).toContain('--disable');
    expect(github.state.clicks).toEqual([]);
  });

  it('refuses --enable and --disable together', async () => {
    const github = securityGitHub();

    const result = await run(
      ['dependency-graph', REPO, '--enable', '--disable'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(github.state.clicks).toEqual([]);
  });

  it('refuses to select repositories by pattern', async () => {
    const github = securityGitHub();

    const result = await run(
      ['dependency-graph', '--pattern', '*', '--enable'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('cannot be selected by pattern');
  });

  it('needs at least one repository', async () => {
    const github = securityGitHub();

    const result = await run(['status'], { github });

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('Name at least one repository');
  });

  it('accepts a bare repository name together with --org', async () => {
    const github = securityGitHub();

    const result = await run(
      [
        'vulnerability-alerts',
        'gh-manager',
        '--org',
        'link-foundation',
        '--enable',
      ],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(github.state.features['vulnerability-alerts']).toBe('enabled');
  });
});
