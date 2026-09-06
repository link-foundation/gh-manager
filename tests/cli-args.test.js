/**
 * Command line parsing.
 */

import { describe, it, expect } from 'test-anywhere';

import { FLAG_SPECS, parseArgs } from '../src/cli/args.js';
import { EXIT_CODES } from '../src/exit-codes.js';

/**
 * Parse a command line and return the error it produced.
 * @param {string[]} argv - Arguments to parse
 * @returns {Error} The thrown error
 */
function parseFailure(argv) {
  try {
    parseArgs(argv);
  } catch (error) {
    return error;
  }

  throw new Error(`expected ${argv.join(' ')} to be rejected`);
}

describe('parseArgs', () => {
  it('separates positionals from flags', () => {
    const { positionals, flags } = parseArgs([
      'package',
      'public',
      'box',
      'box-dind',
      '--org',
      'link-foundation',
    ]);

    expect(positionals).toEqual(['package', 'public', 'box', 'box-dind']);
    expect(flags.org).toBe('link-foundation');
  });

  it('accepts --flag=value and short aliases', () => {
    const { flags } = parseArgs(['package', 'delete', '--pattern=box*', '-y']);

    expect(flags.pattern).toBe('box*');
    expect(flags.yes).toBe(true);
  });

  it('collects repeated --team and --user flags', () => {
    const { flags } = parseArgs([
      'permissions',
      'grant',
      'box',
      '--team',
      'maintainers',
      '--team',
      'reviewers',
      '--user',
      'someone',
    ]);

    expect(flags.teams).toEqual(['maintainers', 'reviewers']);
    expect(flags.users).toEqual(['someone']);
  });

  it('supports --no- prefixes for boolean flags', () => {
    const { flags } = parseArgs(['package', 'list', '--no-headless']);

    expect(flags.headless).toBe(false);
  });

  it('coerces numeric flags', () => {
    const { flags } = parseArgs(['auth', 'login', '--timeout', '120']);

    expect(flags.timeout).toBe(120);
  });

  it('groups short boolean flags', () => {
    const { flags } = parseArgs(['package', 'delete', 'box', '-yh']);

    expect(flags.yes).toBe(true);
    expect(flags.help).toBe(true);
  });

  it('stops parsing flags after --', () => {
    const { positionals, flags } = parseArgs([
      'package',
      'delete',
      '--',
      '--weird-package-name',
    ]);

    expect(positionals).toEqual(['package', 'delete', '--weird-package-name']);
    expect(flags).toEqual({});
  });

  it('rejects unknown options with the usage exit code', () => {
    const error = parseFailure(['package', 'list', '--nope']);

    expect(error.message).toBe('Unknown option: nope');
    expect(error.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it('rejects a value flag without a value', () => {
    expect(parseFailure(['package', 'list', '--org']).message).toBe(
      '--org expects a value'
    );
    expect(parseFailure(['package', 'list', '--org', '--json']).message).toBe(
      '--org expects a value'
    );
  });

  it('rejects a non-numeric value for a numeric flag', () => {
    expect(parseFailure(['auth', 'login', '--timeout', 'soon']).message).toBe(
      '--timeout expects a number'
    );
  });

  it('rejects short forms of flags that take a value', () => {
    expect(parseFailure(['package', 'list', '-o']).exitCode).toBe(
      EXIT_CODES.USAGE
    );
  });

  it('declares every flag the help text documents', () => {
    for (const name of ['org', 'account', 'pattern', 'regex', 'all', 'json']) {
      expect(Boolean(FLAG_SPECS[name])).toBe(true);
    }

    expect(FLAG_SPECS['dry-run'].key).toBe('dryRun');
    expect(FLAG_SPECS['app-dir'].key).toBe('appDir');
  });
});
