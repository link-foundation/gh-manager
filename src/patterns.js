/**
 * Target resolution for package names.
 *
 * Targets are either listed explicitly on the command line or resolved from a
 * pattern. Glob is the default because it reads better for the common case
 * (`box*`); `--regex` opts into full regular expressions.
 */

import { CliError, EXIT_CODES } from './exit-codes.js';

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Patterns that select everything and therefore need an explicit opt-in. */
const OVER_BROAD_PATTERNS = new Set(['*', '**', '.*', '.+', '^.*$']);

/**
 * Convert a glob pattern into an anchored regular expression source.
 * Only `*` (any run of characters) and `?` (exactly one character) are special.
 * @param {string} pattern - Glob pattern
 * @returns {string} Anchored regular expression source
 */
export function globToRegExpSource(pattern) {
  let source = '';

  for (const character of pattern) {
    if (character === '*') {
      source += '.*';
    } else if (character === '?') {
      source += '.';
    } else {
      source += character.replace(REGEXP_SPECIAL, '\\$&');
    }
  }

  return `^${source}$`;
}

/**
 * Build a matcher function for a pattern.
 * @param {Object} options - Matching options
 * @param {string} options.pattern - Glob (default) or regular expression
 * @param {boolean} [options.regex] - Treat the pattern as a regular expression
 * @returns {(name: string) => boolean} Predicate over package names
 */
export function createMatcher({ pattern, regex = false }) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new CliError('A non-empty --pattern is required', EXIT_CODES.USAGE);
  }

  const source = regex ? pattern : globToRegExpSource(pattern);
  let expression;

  try {
    expression = new RegExp(source, 'i');
  } catch (error) {
    throw new CliError(
      `Invalid ${regex ? 'regular expression' : 'glob'} pattern: ${pattern}`,
      EXIT_CODES.USAGE,
      { cause: error }
    );
  }

  return (name) => expression.test(name);
}

/**
 * Filter package names with a pattern.
 * @param {string[]} names - Known package names
 * @param {Object} options - Matching options (see createMatcher)
 * @returns {string[]} Matching names, in the order they were given
 */
export function matchPackageNames(names, options) {
  const matches = createMatcher(options);
  return names.filter((name) => matches(name));
}

/**
 * Report whether a pattern selects everything, which is never done silently.
 * @param {Object} options - Matching options
 * @param {string} options.pattern - Pattern to inspect
 * @param {boolean} [options.regex] - Whether the pattern is a regular expression
 * @returns {boolean} True when the pattern is unbounded
 */
export function isOverBroadPattern({ pattern, regex = false }) {
  const trimmed = String(pattern ?? '').trim();

  if (OVER_BROAD_PATTERNS.has(trimmed)) {
    return true;
  }

  return regex && (trimmed === '' || trimmed === '^' || trimmed === '$');
}

/**
 * Resolve the package names a command should act on.
 *
 * Explicit targets win; otherwise the pattern is expanded against the packages
 * that actually exist, so a typo fails loudly and never looks like a no-op.
 * @param {Object} options - Resolution options
 * @param {string[]} [options.targets] - Names given on the command line
 * @param {string} [options.pattern] - Pattern to expand
 * @param {boolean} [options.regex] - Treat the pattern as a regular expression
 * @param {boolean} [options.all] - Allow an unbounded pattern
 * @param {() => Promise<string[]>} options.listNames - Lazy package enumeration
 * @returns {Promise<{names: string[], fromPattern: boolean, known: string[]}>} Resolution
 */
export async function resolveTargets({
  targets = [],
  pattern,
  regex = false,
  all = false,
  listNames,
}) {
  if (targets.length > 0 && pattern) {
    throw new CliError(
      'Pass either explicit package names or --pattern, not both',
      EXIT_CODES.USAGE
    );
  }

  if (targets.length > 0) {
    return { names: [...targets], fromPattern: false, known: [] };
  }

  if (!pattern) {
    throw new CliError(
      'No packages given: pass one or more names, or --pattern',
      EXIT_CODES.USAGE
    );
  }

  if (isOverBroadPattern({ pattern, regex }) && !all) {
    throw new CliError(
      `Pattern "${pattern}" selects every package; pass --all to confirm that is intended`,
      EXIT_CODES.USAGE
    );
  }

  const known = await listNames();
  const names = matchPackageNames(known, { pattern, regex });

  if (names.length === 0) {
    throw new CliError(
      `Pattern "${pattern}" matched none of the ${known.length} known package(s)`,
      EXIT_CODES.NO_MATCHES
    );
  }

  return { names, fromPattern: true, known };
}
