/**
 * The `package` domain: list packages, change their visibility, delete them.
 *
 * Every write goes through the gateway, which performs the change in the
 * browser and then re-reads the package to confirm it. A verb only reports
 * success for a change it could observe afterwards.
 */

import { EXIT_CODES } from '../exit-codes.js';
import { VISIBILITIES } from '../browser/selectors.js';
import {
  applyAll,
  confirmPlan,
  printJson,
  resolvePackageTargets,
  stopForDryRun,
} from './targets.js';

/**
 * Describe where a listing came from, for the summary line.
 * @param {string} source - 'api' or 'browser'
 * @returns {string} Human readable explanation
 */
function describeSource(source) {
  return source === 'api'
    ? 'listed through the GitHub API'
    : 'enumerated in the browser, because the API returned no packages';
}

/**
 * List the packages of the selected account.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function list(context) {
  const owner = context.owner();
  const { packages, source } = await context.packages().listPackages();

  if (context.flags.json) {
    return printJson(context, { owner, packages, source });
  }

  if (packages.length === 0) {
    context.log.info(
      `No ${context.settings.packageType} packages found for ${owner.name}.`
    );
    return EXIT_CODES.SUCCESS;
  }

  const width = Math.max(...packages.map((entry) => entry.name.length));

  for (const entry of packages) {
    context.log.info(
      `${entry.name.padEnd(width)}  ${entry.visibility ?? 'unknown'}`
    );
  }

  context.log.info(`${packages.length} package(s), ${describeSource(source)}.`);
  return EXIT_CODES.SUCCESS;
}

/**
 * Change the visibility of every selected package.
 * @param {Object} context - Run context
 * @param {string} visibility - Target visibility
 * @returns {Promise<number>} Exit code
 */
async function setVisibility(context, visibility) {
  const gateway = context.packages();
  const { names, fromPattern } = await resolvePackageTargets(context);

  await confirmPlan(context, {
    title: `Setting ${names.length} package(s) to ${visibility}:`,
    items: names,
    fromPattern,
  });

  if (stopForDryRun(context)) {
    return EXIT_CODES.SUCCESS;
  }

  return applyAll(context, {
    items: names,
    run: (packageName) => gateway.setVisibility({ packageName, visibility }),
    describe: (packageName, result) =>
      result.changed
        ? `${packageName} is now ${visibility} (verified through the ${result.verifiedBy}).`
        : `${packageName} was already ${visibility}.`,
  });
}

/**
 * Delete every selected package.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function remove(context) {
  const gateway = context.packages();
  const { names, fromPattern } = await resolvePackageTargets(context);

  await confirmPlan(context, {
    title: `Deleting ${names.length} package(s) from ${context.owner().name}. This cannot be undone:`,
    items: names,
    fromPattern,
    // Deletion always asks, whether the names were typed or matched.
    always: true,
  });

  if (stopForDryRun(context)) {
    return EXIT_CODES.SUCCESS;
  }

  return applyAll(context, {
    items: names,
    run: (packageName) => gateway.deletePackage({ packageName }),
    describe: (packageName, result) =>
      `${packageName} was deleted (verified through the ${result.verifiedBy}).`,
  });
}

/**
 * Build a visibility verb.
 * @param {string} visibility - Target visibility
 * @returns {{summary: string, run: Function}} Verb definition
 */
function visibilityVerb(visibility) {
  return {
    summary: `Make the selected packages ${visibility}`,
    run: (context) => setVisibility(context, visibility),
  };
}

/** The `package` command domain. */
export const packageDomain = {
  name: 'package',
  summary: 'List packages, change their visibility, delete them',
  usage: [
    'gh-manager package list --org <org>',
    'gh-manager package public <name...> --org <org>',
    'gh-manager package private --pattern "box*" --org <org>',
    'gh-manager package delete <name...> --org <org> [--dry-run] [--yes]',
    'gh-manager package permissions list --pattern "box*" --org <org>',
    '',
    'Targets are package names, or --pattern with a glob (--regex for a',
    'regular expression). Pattern runs always print the resolved list and ask',
    'for confirmation; --yes answers that question in advance.',
  ],
  // `package permissions <verb>` reads the way access to a package is usually
  // spoken about, so it forwards to the `permissions` domain, which can also
  // be reached directly.
  nested: { permissions: 'permissions' },
  verbs: {
    list: { summary: 'List the packages of an account', run: list },
    ...Object.fromEntries(
      VISIBILITIES.map((visibility) => [visibility, visibilityVerb(visibility)])
    ),
    delete: { summary: 'Delete the selected packages', run: remove },
  },
};
