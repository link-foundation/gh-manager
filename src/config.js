/**
 * Application directory and configuration handling.
 *
 * gh-manager owns a directory (`~/.gh-manager/` by default) that holds the
 * dedicated Chrome profile, the persisted defaults, and the run logs:
 *
 *   ~/.gh-manager/
 *   ├── config.json
 *   ├── chrome-profile/
 *   └── logs/
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { CliError, EXIT_CODES } from './exit-codes.js';

/** Built-in defaults, overridable by config file, environment, and flags. */
export const DEFAULT_CONFIG = {
  org: null,
  account: null,
  engine: 'playwright',
  channel: 'chrome',
  headless: false,
  packageType: 'container',
};

/** Configuration keys that may be persisted in config.json. */
export const CONFIGURABLE_KEYS = Object.keys(DEFAULT_CONFIG);

/**
 * Resolve the application directory.
 * @param {Object} [options] - Resolution inputs
 * @param {string} [options.appDir] - Value of --app-dir
 * @param {Object} [options.env] - Environment variables
 * @param {string} [options.home] - Home directory override
 * @returns {string} Absolute path of the application directory
 */
export function resolveAppDir({
  appDir,
  env = process.env,
  home = homedir(),
} = {}) {
  const configured = appDir || env.GH_MANAGER_HOME;
  return path.resolve(configured || path.join(home, '.gh-manager'));
}

/**
 * Build the well-known paths inside an application directory.
 * @param {string} appDir - Application directory
 * @returns {{appDir: string, configFile: string, profileDir: string, logsDir: string}} Paths
 */
export function appPaths(appDir) {
  return {
    appDir,
    configFile: path.join(appDir, 'config.json'),
    profileDir: path.join(appDir, 'chrome-profile'),
    logsDir: path.join(appDir, 'logs'),
  };
}

/**
 * Create the application directory tree if it does not exist yet.
 * @param {string} appDir - Application directory
 * @returns {{appDir: string, configFile: string, profileDir: string, logsDir: string}} Paths
 */
export function ensureAppDir(appDir) {
  const paths = appPaths(appDir);
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.profileDir, { recursive: true });
  return paths;
}

/**
 * Read config.json, tolerating a missing file but not a malformed one.
 * @param {string} appDir - Application directory
 * @returns {Object} Stored configuration values
 */
export function loadStoredConfig(appDir) {
  const { configFile } = appPaths(appDir);
  let contents;

  try {
    contents = readFileSync(configFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    throw new CliError(
      `Cannot read ${configFile}: ${error.message}`,
      EXIT_CODES.FAILURE,
      { cause: error }
    );
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new CliError(
      `${configFile} is not valid JSON: ${error.message}`,
      EXIT_CODES.FAILURE,
      { cause: error }
    );
  }
}

/**
 * Write config.json verbatim, replacing whatever it held.
 * @param {string} appDir - Application directory
 * @param {Object} values - Complete configuration to store
 * @returns {Object} The values that were written
 */
export function writeStoredConfig(appDir, values) {
  const paths = ensureAppDir(appDir);
  writeFileSync(paths.configFile, `${JSON.stringify(values, null, 2)}\n`);
  return values;
}

/**
 * Persist configuration values, merging them into what is already stored.
 * @param {string} appDir - Application directory
 * @param {Object} values - Values to store
 * @returns {Object} The full stored configuration after the merge
 */
export function saveStoredConfig(appDir, values) {
  return writeStoredConfig(appDir, { ...loadStoredConfig(appDir), ...values });
}

/**
 * Read the configuration values a command line supplied.
 * @param {Object} flags - Parsed command line flags
 * @returns {Object} Only the keys the command line actually set
 */
function configFromFlags(flags) {
  const provided = {};

  for (const key of CONFIGURABLE_KEYS) {
    if (flags[key] !== undefined) {
      provided[key] = flags[key];
    }
  }

  return provided;
}

/**
 * Merge built-in defaults, config.json, and command line flags.
 *
 * Later sources win, so a flag always beats a stored default.
 * @param {Object} [options] - Merge inputs
 * @param {Object} [options.flags] - Parsed command line flags
 * @param {Object} [options.env] - Environment variables
 * @param {string} [options.home] - Home directory override
 * @returns {Object} Effective settings, including resolved paths
 */
export function resolveSettings({
  flags = {},
  env = process.env,
  home = homedir(),
} = {}) {
  const appDir = resolveAppDir({ appDir: flags.appDir, env, home });
  const stored = loadStoredConfig(appDir);

  return {
    ...DEFAULT_CONFIG,
    ...stored,
    ...configFromFlags(flags),
    ...appPaths(appDir),
  };
}

/**
 * Resolve which account owns the packages a command targets.
 *
 * GitHub serves organization packages under `/orgs/<org>/` and personal ones
 * under `/users/<user>/`, and the REST paths differ the same way.
 * @param {Object} settings - Effective settings
 * @returns {{scope: 'orgs'|'users', name: string}} Owner descriptor
 */
export function resolveOwner(settings) {
  if (settings.org && settings.account) {
    throw new CliError(
      'Pass either --org or --account, not both',
      EXIT_CODES.USAGE
    );
  }

  if (settings.org) {
    return { scope: 'orgs', name: settings.org };
  }

  if (settings.account) {
    return { scope: 'users', name: settings.account };
  }

  throw new CliError(
    'No account given: pass --org <organization> or --account <login>, or store a default with `gh-manager config set org <organization>`',
    EXIT_CODES.USAGE
  );
}
