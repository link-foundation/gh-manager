/**
 * Repository coordinates.
 *
 * A repository is named on the command line either in full (`owner/repo`) or
 * on its own (`repo`), in which case the account the run is already bound to
 * (`--org`, `--account`, or the stored default) owns it. Anything else — a
 * glob, a URL, a three-part path — is rejected here and never sent to
 * GitHub, because a mistyped target is the one input that must never be
 * guessed at for a command that changes settings.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';

/** Characters GitHub accepts in an owner or repository name. */
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Render a repository as `owner/name`.
 * @param {{owner: string, name: string}} repo - Repository descriptor
 * @returns {string} Slug
 */
export function repoSlug(repo) {
  return `${repo.owner}/${repo.name}`;
}

/**
 * Reject a name GitHub could not carry.
 * @param {string} value - Candidate owner or repository name
 * @param {string} spec - Original target, for the error message
 * @returns {string} The name, when it is usable
 */
function requireName(value, spec) {
  if (NAME.test(value) && value !== '.' && value !== '..') {
    return value;
  }

  throw new CliError(
    `"${spec}" is not a repository. Name one as <owner>/<repo>, or as <repo> together with --org or --account.`,
    EXIT_CODES.USAGE
  );
}

/**
 * Parse one repository target.
 * @param {string} spec - Target as typed, `owner/repo` or `repo`
 * @param {Object} options - Resolution options
 * @param {() => {name: string}} options.defaultOwner - Owner for a bare name
 * @returns {{owner: string, name: string}} Repository descriptor
 */
export function parseRepoSpec(spec, { defaultOwner }) {
  const parts = String(spec ?? '')
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .split('/');

  if (parts.length > 2) {
    throw new CliError(
      `"${spec}" names more than a repository. Use <owner>/<repo>.`,
      EXIT_CODES.USAGE
    );
  }

  if (parts.length === 2) {
    return {
      owner: requireName(parts[0], spec),
      name: requireName(parts[1], spec),
    };
  }

  return {
    owner: defaultOwner().name,
    name: requireName(parts[0], spec),
  };
}

/**
 * Parse every repository target of a command line.
 *
 * Patterns are refused loudly, never ignored: a run that silently dropped
 * `--pattern` would act on a different set of repositories than the operator
 * asked for.
 * @param {Object} context - Run context
 * @returns {Array<{owner: string, name: string}>} Repository descriptors
 */
export function resolveRepoTargets(context) {
  if (context.flags.pattern || context.flags.all) {
    throw new CliError(
      'Repository targets cannot be selected by pattern: name each repository as <owner>/<repo>.',
      EXIT_CODES.USAGE
    );
  }

  if (context.targets.length === 0) {
    throw new CliError(
      'Name at least one repository, as <owner>/<repo> or as <repo> with --org or --account.',
      EXIT_CODES.USAGE
    );
  }

  return context.targets.map((spec) =>
    parseRepoSpec(spec, { defaultOwner: () => context.owner() })
  );
}
