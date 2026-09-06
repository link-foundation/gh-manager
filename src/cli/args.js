/**
 * Command line parsing.
 *
 * The grammar is `gh-manager <domain> <verb> [targets...] [flags]`. Flags are
 * declared once here so the parser, the usage text, and the tests agree on what
 * exists and which flags take a value.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';

/**
 * Declared flags.
 *
 * `key` is the camelCase name the rest of the code reads, `type` decides
 * whether a value is consumed, and `multiple` collects repeated occurrences.
 */
export const FLAG_SPECS = {
  'app-dir': { key: 'appDir', type: 'string' },
  org: { key: 'org', type: 'string' },
  account: { key: 'account', type: 'string' },
  'package-type': { key: 'packageType', type: 'string' },
  pattern: { key: 'pattern', type: 'string' },
  regex: { key: 'regex', type: 'boolean' },
  all: { key: 'all', type: 'boolean' },
  'dry-run': { key: 'dryRun', type: 'boolean' },
  yes: { key: 'yes', type: 'boolean', alias: 'y' },
  headless: { key: 'headless', type: 'boolean' },
  engine: { key: 'engine', type: 'string' },
  channel: { key: 'channel', type: 'string' },
  token: { key: 'token', type: 'string' },
  team: { key: 'teams', type: 'string', multiple: true },
  user: { key: 'users', type: 'string', multiple: true },
  role: { key: 'role', type: 'string' },
  from: { key: 'from', type: 'string' },
  timeout: { key: 'timeout', type: 'number' },
  json: { key: 'json', type: 'boolean' },
  verbose: { key: 'verbose', type: 'boolean' },
  help: { key: 'help', type: 'boolean', alias: 'h' },
  version: { key: 'version', type: 'boolean', alias: 'v' },
};

const ALIASES = new Map(
  Object.entries(FLAG_SPECS)
    .filter(([, spec]) => spec.alias)
    .map(([name, spec]) => [spec.alias, name])
);

/**
 * Look up a flag specification by its long or short name.
 * @param {string} name - Flag name without leading dashes
 * @returns {{name: string, spec: Object}} Resolved flag
 */
function findSpec(name) {
  const longName = FLAG_SPECS[name] ? name : ALIASES.get(name);
  const spec = longName ? FLAG_SPECS[longName] : undefined;

  if (!spec) {
    throw new CliError(`Unknown option: ${name}`, EXIT_CODES.USAGE);
  }

  return { name: longName, spec };
}

/**
 * Store one parsed flag value.
 * @param {Object} flags - Accumulator
 * @param {Object} spec - Flag specification
 * @param {string|boolean|number} value - Parsed value
 * @returns {void}
 */
function assign(flags, spec, value) {
  if (!spec.multiple) {
    flags[spec.key] = value;
    return;
  }

  flags[spec.key] = [...(flags[spec.key] ?? []), value];
}

/**
 * Coerce a raw flag value to the declared type.
 * @param {string} name - Flag name, for error messages
 * @param {Object} spec - Flag specification
 * @param {string} raw - Raw string from the command line
 * @returns {string|number} Coerced value
 */
function coerce(name, spec, raw) {
  if (spec.type !== 'number') {
    return raw;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${name} expects a number`, EXIT_CODES.USAGE);
  }

  return parsed;
}

/**
 * Parse a long option, consuming a value from the argument list if needed.
 * @param {Object} options - Parse state
 * @param {string} options.token - Argument starting with `--`
 * @param {string[]} options.argv - Full argument list
 * @param {number} options.index - Index of the current argument
 * @param {Object} options.flags - Accumulator
 * @returns {number} Index of the last argument consumed
 */
function parseLongOption({ token, argv, index, flags }) {
  const body = token.slice(2);
  const equals = body.indexOf('=');
  const rawName = equals === -1 ? body : body.slice(0, equals);
  const inlineValue = equals === -1 ? undefined : body.slice(equals + 1);

  if (rawName.startsWith('no-') && !FLAG_SPECS[rawName]) {
    const { spec } = findSpec(rawName.slice(3));
    assign(flags, spec, false);
    return index;
  }

  const { name, spec } = findSpec(rawName);

  if (spec.type === 'boolean') {
    if (inlineValue !== undefined) {
      assign(flags, spec, inlineValue !== 'false');
      return index;
    }

    assign(flags, spec, true);
    return index;
  }

  if (inlineValue !== undefined) {
    assign(flags, spec, coerce(name, spec, inlineValue));
    return index;
  }

  const next = argv[index + 1];

  if (next === undefined || next.startsWith('-')) {
    throw new CliError(`--${name} expects a value`, EXIT_CODES.USAGE);
  }

  assign(flags, spec, coerce(name, spec, next));
  return index + 1;
}

/**
 * Parse the gh-manager command line.
 * @param {string[]} argv - Arguments after the executable and script
 * @returns {{positionals: string[], flags: Object}} Parsed command line
 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  let onlyPositionals = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (onlyPositionals || token === '-' || !token.startsWith('-')) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      onlyPositionals = true;
      continue;
    }

    if (token.startsWith('--')) {
      index = parseLongOption({ token, argv, index, flags });
      continue;
    }

    for (const short of token.slice(1)) {
      const { name, spec } = findSpec(short);

      if (spec.type !== 'boolean') {
        throw new CliError(
          `-${short} (--${name}) expects a value; use the long form`,
          EXIT_CODES.USAGE
        );
      }

      assign(flags, spec, true);
    }
  }

  return { positionals, flags };
}
