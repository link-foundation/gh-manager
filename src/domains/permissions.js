/**
 * The `permissions` domain: who may read, write, or administer a package.
 *
 * GitHub exposes no API for package permissions, so all of this is driven in
 * the settings page and every change is re-read afterwards. `sync` turns a
 * policy file into the same grant and revoke operations, which is what makes
 * bulk permission changes reviewable before they run.
 */

import { readFile } from 'node:fs/promises';

import {
  grantPackageAccess,
  listPackageAccess,
  revokePackageAccess,
} from '../browser/package-access.js';
import { ROLES } from '../browser/selectors.js';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { matchPackageNames } from '../patterns.js';
import {
  describeOperation,
  diffAccess,
  parsePolicy,
  validateRole,
} from '../permissions/policy.js';
import {
  applyAll,
  confirmPlan,
  printJson,
  resolvePackageTargets,
  stopForDryRun,
} from './targets.js';

/**
 * Read the teams and users named on the command line.
 * @param {Object} flags - Parsed flags
 * @returns {Array<{type: string, name: string}>} Grantees
 */
function granteesFromFlags(flags) {
  const grantees = [
    ...(flags.teams ?? []).map((name) => ({ type: 'team', name })),
    ...(flags.users ?? []).map((name) => ({ type: 'user', name })),
  ];

  if (grantees.length === 0) {
    throw new CliError(
      'No grantee given: pass --team <name> or --user <login>',
      EXIT_CODES.USAGE
    );
  }

  return grantees;
}

/**
 * Build the options the browser drivers expect for one package.
 * @param {Object} context - Run context
 * @param {string} packageName - Package name
 * @returns {Object} Driver options
 */
function packageOptions(context, packageName) {
  return {
    owner: context.owner(),
    packageType: context.settings.packageType,
    packageName,
    log: context.log,
  };
}

/**
 * Show a plan, ask when it takes access away, and then apply it.
 * @param {Object} context - Run context
 * @param {Object} options - Execution options
 * @param {string} options.title - Plan title
 * @param {Array<Object>} options.operations - Operations from diffAccess
 * @param {boolean} [options.fromPattern] - Whether packages came from a pattern
 * @returns {Promise<number>} Exit code
 */
async function runOperations(context, { title, operations, fromPattern }) {
  if (operations.length === 0) {
    context.log.info('Nothing to do: the access lists already match.');
    return EXIT_CODES.SUCCESS;
  }

  await confirmPlan(context, {
    title,
    items: operations.map(describeOperation),
    fromPattern,
    // Taking access away is destructive, so it is always confirmed.
    always: operations.some((operation) => operation.kind === 'revoke'),
  });

  if (stopForDryRun(context)) {
    return EXIT_CODES.SUCCESS;
  }

  const session = await context.getSession();

  return applyAll(context, {
    items: operations,
    label: describeOperation,
    run: (operation) =>
      operation.kind === 'grant'
        ? grantPackageAccess(session, {
            ...packageOptions(context, operation.packageName),
            grantee: operation.grantee,
            role: operation.role,
          })
        : revokePackageAccess(session, {
            ...packageOptions(context, operation.packageName),
            grantee: operation.grantee,
          }),
    describe: (operation, result) =>
      `${describeOperation(operation)}: ${result.changed ? 'done' : 'already in place'}.`,
  });
}

/**
 * Read the access rows of every selected package.
 * @param {Object} context - Run context
 * @param {string[]} names - Package names
 * @returns {Promise<Array<{packageName: string, access: Array<Object>}>>} Rows per package
 */
async function readAccess(context, names) {
  const session = await context.getSession();
  const report = [];

  for (const packageName of names) {
    report.push({
      packageName,
      access: await listPackageAccess(
        session,
        packageOptions(context, packageName)
      ),
    });
  }

  return report;
}

/**
 * List who has access to the selected packages.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function list(context) {
  const { names } = await resolvePackageTargets(context);
  const report = await readAccess(context, names);

  if (context.flags.json) {
    return printJson(context, report);
  }

  for (const entry of report) {
    context.log.info(`${entry.packageName}:`);

    if (entry.access.length === 0) {
      context.log.info('  (no team or user has package-level access)');
      continue;
    }

    for (const row of entry.access) {
      context.log.info(`  ${row.type} ${row.name}: ${row.role}`);
    }
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * Build the operations for `grant` and `revoke`.
 * @param {Object} context - Run context
 * @param {string} kind - 'grant' or 'revoke'
 * @returns {Promise<{operations: Array<Object>, fromPattern: boolean, names: string[]}>} Plan
 */
async function planFromFlags(context, kind) {
  const grantees = granteesFromFlags(context.flags);
  const role = kind === 'grant' ? requiredRole(context.flags) : null;
  const { names, fromPattern } = await resolvePackageTargets(context);
  const operations = [];

  for (const packageName of names) {
    for (const grantee of grantees) {
      operations.push({ kind, packageName, grantee, role });
    }
  }

  return { operations, fromPattern, names };
}

/**
 * Read the role `grant` needs.
 * @param {Object} flags - Parsed flags
 * @returns {string} Validated role
 */
function requiredRole(flags) {
  if (!flags.role) {
    throw new CliError(
      `No role given: pass --role <${ROLES.join('|')}>`,
      EXIT_CODES.USAGE
    );
  }

  return validateRole(flags.role, '--role');
}

/**
 * Give teams or users a role on the selected packages.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function grant(context) {
  const { operations, fromPattern } = await planFromFlags(context, 'grant');

  return runOperations(context, {
    title: `Applying ${operations.length} permission change(s):`,
    operations,
    fromPattern,
  });
}

/**
 * Take access to the selected packages away.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function revoke(context) {
  const { operations, fromPattern } = await planFromFlags(context, 'revoke');

  return runOperations(context, {
    title: `Removing ${operations.length} access entr(y/ies):`,
    operations,
    fromPattern,
  });
}

/**
 * Expand one policy entry into concrete package names.
 * @param {Object} context - Run context
 * @param {Object} entry - Normalized policy entry
 * @returns {Promise<string[]>} Package names
 */
async function namesForEntry(context, entry) {
  if (!entry.pattern) {
    return entry.names;
  }

  const known = await context.packages().listNames();
  const matches = matchPackageNames(known, {
    pattern: entry.pattern,
    regex: entry.regex,
  });

  if (matches.length === 0) {
    throw new CliError(
      `Policy pattern "${entry.pattern}" matched none of the ${known.length} known package(s)`,
      EXIT_CODES.NO_MATCHES
    );
  }

  return [...new Set([...entry.names, ...matches])];
}

/**
 * Converge the access lists of the packages a policy file describes.
 * @param {Object} context - Run context
 * @returns {Promise<number>} Exit code
 */
async function sync(context) {
  const file = context.flags.from;

  if (!file) {
    throw new CliError(
      'No policy given: pass --from <policy.json>',
      EXIT_CODES.USAGE
    );
  }

  const policy = parsePolicy(JSON.parse(await readFile(file, 'utf8')));
  const operations = [];

  for (const entry of policy.entries) {
    const names = await namesForEntry(context, entry);

    for (const { packageName, access } of await readAccess(context, names)) {
      operations.push(
        ...diffAccess({
          packageName,
          current: access,
          desired: entry.grantees,
          exclusive: entry.exclusive,
        })
      );
    }
  }

  return runOperations(context, {
    title: `Syncing ${file}: ${operations.length} change(s):`,
    operations,
    fromPattern: true,
  });
}

/** The `permissions` command domain. */
export const permissionsDomain = {
  name: 'permissions',
  summary: 'Read and change who can access packages',
  usage: [
    'gh-manager permissions list --pattern "box*" --org <org>',
    'gh-manager permissions grant <name...> --team maintainers --role write --org <org>',
    'gh-manager permissions revoke --pattern "box*" --user someone --org <org>',
    'gh-manager permissions sync --from policy.json --org <org> [--dry-run]',
    '',
    `Roles are ${ROLES.join(', ')}. A policy file lists packages with the`,
    'teams and users that should have access; grantees it omits are revoked',
    'unless the entry sets "exclusive": false.',
  ],
  verbs: {
    list: { summary: 'Show package-level access', run: list },
    grant: { summary: 'Give a team or user a role', run: grant },
    revoke: { summary: 'Remove a team or user', run: revoke },
    sync: { summary: 'Apply a policy file', run: sync },
  },
};
