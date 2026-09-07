/**
 * Pattern matching and target resolution.
 *
 * These rules are the safety net of every destructive command: a pattern is
 * only ever expanded against packages that really exist, and a pattern that
 * would select everything is refused unless it is confirmed explicitly.
 */

import { describe, it, expect } from 'test-anywhere';

import { EXIT_CODES } from '../src/exit-codes.js';
import {
  createMatcher,
  globToRegExpSource,
  isOverBroadPattern,
  matchPackageNames,
  resolveTargets,
} from '../src/patterns.js';

const known = ['box', 'box-dind', 'box-slim', 'gh-manager', 'deep.index'];

/**
 * List the packages a resolution should be expanded against.
 * @returns {Promise<string[]>} Known package names
 */
async function listNames() {
  return known;
}

/**
 * Resolve targets and return the error that was thrown.
 * @param {Object} options - resolveTargets options
 * @returns {Promise<Error>} The thrown error
 */
async function resolveFailure(options) {
  try {
    await resolveTargets({ listNames, ...options });
  } catch (error) {
    return error;
  }

  throw new Error('expected the resolution to be rejected');
}

describe('globToRegExpSource', () => {
  it('anchors the pattern and only treats * and ? as wildcards', () => {
    expect(globToRegExpSource('box*')).toBe('^box.*$');
    expect(globToRegExpSource('box-?')).toBe('^box-.$');
    expect(globToRegExpSource('deep.index')).toBe('^deep\\.index$');
  });
});

describe('matchPackageNames', () => {
  it('matches globs case insensitively', () => {
    expect(matchPackageNames(known, { pattern: 'box*' })).toEqual([
      'box',
      'box-dind',
      'box-slim',
    ]);
    expect(matchPackageNames(known, { pattern: 'BOX-*' })).toEqual([
      'box-dind',
      'box-slim',
    ]);
  });

  it('does not let a dot in a glob match any character', () => {
    expect(
      matchPackageNames(['deep.index', 'deepXindex'], { pattern: 'deep.index' })
    ).toEqual(['deep.index']);
  });

  it('accepts regular expressions when asked', () => {
    expect(
      matchPackageNames(known, { pattern: '^box-(dind|slim)$', regex: true })
    ).toEqual(['box-dind', 'box-slim']);
  });

  it('rejects an empty pattern', () => {
    try {
      createMatcher({ pattern: '' });
    } catch (error) {
      expect(error.exitCode).toBe(EXIT_CODES.USAGE);
      return;
    }

    throw new Error('expected an empty pattern to be rejected');
  });

  it('reports an invalid regular expression and never crashes', () => {
    try {
      createMatcher({ pattern: 'box(', regex: true });
    } catch (error) {
      expect(error.message).toBe('Invalid regular expression pattern: box(');
      expect(error.exitCode).toBe(EXIT_CODES.USAGE);
      return;
    }

    throw new Error('expected an invalid regular expression to be rejected');
  });
});

describe('isOverBroadPattern', () => {
  it('recognizes the patterns that select everything', () => {
    expect(isOverBroadPattern({ pattern: '*' })).toBe(true);
    expect(isOverBroadPattern({ pattern: ' ** ' })).toBe(true);
    expect(isOverBroadPattern({ pattern: '.*', regex: true })).toBe(true);
    expect(isOverBroadPattern({ pattern: '^', regex: true })).toBe(true);
  });

  it('recognizes unbounded patterns however they are spelled', () => {
    // Judging a pattern by its spelling missed every one of these, and each
    // selects every package while skipping the --all confirmation.
    expect(isOverBroadPattern({ pattern: '?*' })).toBe(true);
    expect(isOverBroadPattern({ pattern: '*?' })).toBe(true);
    expect(isOverBroadPattern({ pattern: '***' })).toBe(true);
    expect(isOverBroadPattern({ pattern: '.*.*', regex: true })).toBe(true);
    expect(isOverBroadPattern({ pattern: '.+', regex: true })).toBe(true);
    expect(isOverBroadPattern({ pattern: '^.*$', regex: true })).toBe(true);
  });

  it('leaves bounded patterns alone', () => {
    expect(isOverBroadPattern({ pattern: 'box*' })).toBe(false);
    expect(isOverBroadPattern({ pattern: '^box', regex: true })).toBe(false);
    expect(isOverBroadPattern({ pattern: 'sandbox*' })).toBe(false);
    expect(isOverBroadPattern({ pattern: '*-dind' })).toBe(false);
    expect(isOverBroadPattern({ pattern: '**a*' })).toBe(false);
  });

  it('does not call an unparseable pattern unbounded', () => {
    // resolveTargets reports the syntax error; treating it as "matches
    // everything" would ask for --all on a pattern that cannot run at all.
    expect(isOverBroadPattern({ pattern: '[', regex: true })).toBe(false);
  });
});

describe('resolveTargets', () => {
  it('uses explicit names without enumerating anything', async () => {
    let listed = false;
    const resolved = await resolveTargets({
      targets: ['box', 'box-dind'],
      listNames: async () => {
        listed = true;
        return known;
      },
    });

    expect(resolved.names).toEqual(['box', 'box-dind']);
    expect(resolved.fromPattern).toBe(false);
    expect(listed).toBe(false);
  });

  it('expands a pattern against the packages that exist', async () => {
    const resolved = await resolveTargets({ pattern: 'box*', listNames });

    expect(resolved.names).toEqual(['box', 'box-dind', 'box-slim']);
    expect(resolved.fromPattern).toBe(true);
    expect(resolved.known).toEqual(known);
  });

  it('refuses names and a pattern at the same time', async () => {
    const error = await resolveFailure({ targets: ['box'], pattern: 'box*' });

    expect(error.message).toBe(
      'Pass either explicit package names or --pattern, not both'
    );
    expect(error.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it('refuses to act without any target', async () => {
    expect((await resolveFailure({})).exitCode).toBe(EXIT_CODES.USAGE);
  });

  it('never expands an over-broad pattern silently', async () => {
    const error = await resolveFailure({ pattern: '*' });

    expect(error.message).toBe(
      'Pattern "*" selects every package; pass --all to confirm that is intended'
    );
    expect(error.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it('expands an over-broad pattern when --all is given', async () => {
    const resolved = await resolveTargets({
      pattern: '*',
      all: true,
      listNames,
    });

    expect(resolved.names).toEqual(known);
  });

  it('fails loudly when a pattern matches nothing', async () => {
    const error = await resolveFailure({ pattern: 'nothing-*' });

    expect(error.message).toContain('matched none of the 5 known package(s)');
    expect(error.exitCode).toBe(EXIT_CODES.NO_MATCHES);
  });
});
