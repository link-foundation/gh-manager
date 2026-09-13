/**
 * The `security` domain: a repository's "Code security and analysis" toggles.
 *
 * The dependency graph is why this domain exists. A repository whose graph is
 * off fails `actions/dependency-review` with "Dependency review is not
 * supported on this repository", and GitHub offers no endpoint to turn it on —
 * only the settings page. The neighbouring toggles do have endpoints, so each
 * verb takes the shortest honest route: the API where one exists, the browser
 * where it does not, and a re-read either way before reporting success.
 */

import { CliError, EXIT_CODES, exitCodeForError } from '../exit-codes.js';
import { repoSlug, resolveRepoTargets } from '../github/repo.js';
import { SECURITY_FEATURES } from '../security/features.js';
import { applyAll, confirmPlan, printJson, stopForDryRun } from './targets.js';

/**
 * Read which state the command line asks for.
 * @param {Object} context - Run context
 * @param {Object} feature - Feature definition
 * @returns {boolean} True for `--enable`, false for `--disable`
 */
function wantedState(context, feature) {
  const enable = Boolean(context.flags.enable);
  const disable = Boolean(context.flags.disable);

  if (enable === disable) {
    throw new CliError(
      `Say which way to set "${feature.label}": \`gh-manager security ${feature.id} <owner>/<repo> --enable\` or \`--disable\`.`,
      EXIT_CODES.USAGE
    );
  }

  return enable;
}

/**
 * Describe where a reading came from, for the status listing.
 * @param {string} source - 'api', 'page', or 'none'
 * @returns {string} Human readable suffix
 */
function describeSource(source) {
  if (source === 'api') {
    return '';
  }

  return source === 'page'
    ? '  (read from the settings page)'
    : '  (neither the API nor the page could report it)';
}

/**
 * Report the state of every feature of every named repository.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function status(context) {
  const repos = resolveRepoTargets(context);
  const report = [];
  const failures = [];

  for (const repo of repos) {
    try {
      report.push({
        repository: repoSlug(repo),
        features: await context.security(repo).readAll(),
      });
    } catch (error) {
      failures.push(error);
      context.log.error(`${repoSlug(repo)}: ${error.message}`);
    }
  }

  if (context.flags.json) {
    printJson(context, report);
  } else {
    const width = Math.max(
      ...SECURITY_FEATURES.map((feature) => feature.id.length)
    );

    for (const entry of report) {
      context.log.info(entry.repository);

      for (const feature of entry.features) {
        context.log.info(
          `  ${feature.id.padEnd(width)}  ${feature.state}${describeSource(feature.source)}`
        );
      }
    }
  }

  return failures.length === 0
    ? EXIT_CODES.SUCCESS
    : exitCodeForError(failures[0]);
}

/**
 * Turn one feature on or off for every named repository.
 * @param {Object} context - Run context
 * @param {Object} feature - Feature definition
 * @returns {Promise<number>} Exit code
 */
async function setFeature(context, feature) {
  const enabled = wantedState(context, feature);
  const repos = resolveRepoTargets(context);
  const action = enabled ? 'Enabling' : 'Disabling';

  await confirmPlan(context, {
    title: `${action} "${feature.label}" on ${repos.length} repository(ies):`,
    items: repos.map(repoSlug),
    // Security settings are asked about however the repository was named:
    // turning one off removes a protection, and turning one on can start
    // alerting a whole organization.
    always: true,
  });

  if (stopForDryRun(context)) {
    return EXIT_CODES.SUCCESS;
  }

  return applyAll(context, {
    items: repos,
    label: repoSlug,
    run: (repo) => context.security(repo).setFeature({ feature, enabled }),
    describe: (repo, result) =>
      result.changed
        ? `${repoSlug(repo)}: "${feature.label}" is now ${result.state}, set through the ${result.changedBy} and verified through the ${result.verifiedBy}.`
        : `${repoSlug(repo)}: "${feature.label}" was already ${result.state}.`,
  });
}

/**
 * Build the verb that flips one feature.
 * @param {Object} feature - Feature definition
 * @returns {{summary: string, run: Function}} Verb definition
 */
function featureVerb(feature) {
  return {
    summary: `${feature.label}: ${feature.summary} (--enable or --disable)`,
    run: (context) => setFeature(context, feature),
  };
}

/** The `security` command domain. */
export const securityDomain = {
  name: 'security',
  summary: "Read and set a repository's code security settings",
  usage: [
    'gh-manager security status <owner>/<repo> [--json]',
    'gh-manager security dependency-graph <owner>/<repo> --enable',
    'gh-manager security vulnerability-alerts <owner>/<repo> --enable --yes',
    'gh-manager security secret-scanning <owner>/<repo> --disable',
    '',
    'Targets are repositories, named as <owner>/<repo>, or as <repo> together',
    'with --org or --account. Every change asks for confirmation unless --yes',
    'is given, and is reported only after a read confirmed it.',
  ],
  verbs: {
    status: {
      summary: 'Show every code security setting of a repository',
      run: status,
    },
    ...Object.fromEntries(
      SECURITY_FEATURES.map((feature) => [feature.id, featureVerb(feature)])
    ),
  },
};
