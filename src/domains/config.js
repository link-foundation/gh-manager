/**
 * The `config` domain: the defaults stored in `<app-dir>/config.json`.
 *
 * A stored `org` turns every later command into `gh-manager package public
 * box`, with no repeated `--org`. Flags always win over what is stored here.
 */

import {
  CONFIGURABLE_KEYS,
  DEFAULT_CONFIG,
  loadStoredConfig,
  saveStoredConfig,
  writeStoredConfig,
} from '../config.js';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { printJson } from './targets.js';

/**
 * Reject keys that are not configurable.
 * @param {string} key - Key from the command line
 * @returns {string} The key
 */
function requireKey(key) {
  if (!key) {
    throw new CliError(
      `No key given: expected one of ${CONFIGURABLE_KEYS.join(', ')}`,
      EXIT_CODES.USAGE
    );
  }

  if (!CONFIGURABLE_KEYS.includes(key)) {
    throw new CliError(
      `Unknown configuration key "${key}"; expected one of ${CONFIGURABLE_KEYS.join(', ')}`,
      EXIT_CODES.USAGE
    );
  }

  return key;
}

/**
 * Convert a command line value to the type the default suggests.
 * @param {string} key - Configuration key
 * @param {string} value - Raw value
 * @returns {string|boolean|null} Stored value
 */
function coerceValue(key, value) {
  if (typeof DEFAULT_CONFIG[key] === 'boolean') {
    return value !== 'false';
  }

  return value === '' || value === 'null' ? null : value;
}

/**
 * Show the effective settings, and where the application directory is.
 * @param {Object} context - Run context
 * @returns {number} Exit code
 */
function list(context) {
  const stored = loadStoredConfig(context.settings.appDir);

  if (context.flags.json) {
    return printJson(context, {
      appDir: context.settings.appDir,
      stored,
      effective: Object.fromEntries(
        CONFIGURABLE_KEYS.map((key) => [key, context.settings[key]])
      ),
    });
  }

  context.log.info(`# ${context.settings.configFile}`);

  for (const key of CONFIGURABLE_KEYS) {
    const source = key in stored ? 'stored' : 'default';
    context.log.info(`${key} = ${context.settings[key]} (${source})`);
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * Print one effective value, which is what a script would read.
 * @param {Object} context - Run context
 * @returns {number} Exit code
 */
function get(context) {
  const key = requireKey(context.targets[0]);
  context.log.info(String(context.settings[key] ?? ''));
  return EXIT_CODES.SUCCESS;
}

/**
 * Store one value in config.json.
 * @param {Object} context - Run context
 * @returns {number} Exit code
 */
function set(context) {
  const key = requireKey(context.targets[0]);
  const raw = context.targets[1];

  if (raw === undefined) {
    throw new CliError(
      `No value given: gh-manager config set ${key} <value>`,
      EXIT_CODES.USAGE
    );
  }

  const value = coerceValue(key, raw);
  saveStoredConfig(context.settings.appDir, { [key]: value });
  context.log.info(
    `${key} = ${value} (saved in ${context.settings.configFile})`
  );
  return EXIT_CODES.SUCCESS;
}

/**
 * Remove one value, so the built-in default applies again.
 * @param {Object} context - Run context
 * @returns {number} Exit code
 */
function unset(context) {
  const key = requireKey(context.targets[0]);
  const stored = loadStoredConfig(context.settings.appDir);
  delete stored[key];
  writeStoredConfig(context.settings.appDir, stored);
  context.log.info(`${key} now falls back to ${DEFAULT_CONFIG[key]}`);
  return EXIT_CODES.SUCCESS;
}

/** The `config` command domain. */
export const configDomain = {
  name: 'config',
  summary: 'Read and write the stored defaults',
  usage: [
    'gh-manager config list',
    'gh-manager config get org',
    'gh-manager config set org link-foundation',
    'gh-manager config unset org',
    '',
    `Keys: ${CONFIGURABLE_KEYS.join(', ')}.`,
  ],
  verbs: {
    list: { summary: 'Show the effective settings', run: list },
    get: { summary: 'Print one value', run: get },
    set: { summary: 'Store one value', run: set },
    unset: { summary: 'Remove one stored value', run: unset },
  },
};
