/**
 * Shared plumbing for commands that act on a set of packages.
 *
 * The rules that matter for safety live here: a pattern is always expanded
 * against the packages that actually exist, the resolved list is always shown
 * before anything is touched, and a plan that came from a pattern is never
 * executed without a confirmation (or an explicit `--yes`).
 */

import { CliError, EXIT_CODES, exitCodeForError } from '../exit-codes.js';
import { resolveTargets } from '../patterns.js';

/**
 * Resolve the packages a command should act on.
 * @param {Object} context - Run context
 * @returns {Promise<{names: string[], fromPattern: boolean}>} Resolved targets
 */
export function resolvePackageTargets(context) {
  const gateway = context.packages();

  return resolveTargets({
    targets: context.targets,
    pattern: context.flags.pattern,
    regex: Boolean(context.flags.regex),
    all: Boolean(context.flags.all),
    listNames: () => gateway.listNames(),
  });
}

/**
 * Show what is about to happen, and ask before doing it.
 *
 * `always` is used by destructive verbs; other verbs only ask when the list was
 * produced by a pattern, because an explicitly typed name is already a decision.
 * @param {Object} context - Run context
 * @param {Object} options - Confirmation options
 * @param {string} options.title - One-line description of the plan
 * @param {string[]} options.items - Lines describing what the plan covers
 * @param {boolean} [options.fromPattern] - Whether the list came from a pattern
 * @param {boolean} [options.always] - Ask even for explicitly named targets
 * @returns {Promise<void>} Resolves when the operator agreed
 */
export async function confirmPlan(
  context,
  { title, items, fromPattern = false, always = false }
) {
  context.log.info(title);

  for (const item of items) {
    context.log.info(`  - ${item}`);
  }

  if (context.flags.dryRun || !(always || fromPattern)) {
    return;
  }

  const approved = await context.confirm(
    `Proceed with ${items.length} operation(s)?`
  );

  if (!approved) {
    throw new CliError('Aborted: nothing was changed.', EXIT_CODES.ABORTED);
  }
}

/**
 * Report a dry run and tell the caller whether to stop.
 * @param {Object} context - Run context
 * @returns {boolean} True when the run must stop before acting
 */
export function stopForDryRun(context) {
  if (!context.flags.dryRun) {
    return false;
  }

  context.log.info('Dry run: nothing was changed.');
  return true;
}

/**
 * Run an operation for every item, reporting each result as it happens.
 *
 * One failure does not cancel the rest: the remaining items are still
 * processed and the exit code reports the first failure, so a bulk run never
 * stops halfway with an unclear outcome.
 * @param {Object} context - Run context
 * @param {Object} options - Iteration options
 * @param {any[]} options.items - Items to act on
 * @param {(item: any) => Promise<any>} options.run - Operation
 * @param {(item: any, result: any) => string} options.describe - Result line
 * @param {(item: any) => string} [options.label] - Item name, used in errors
 * @returns {Promise<number>} Exit code
 */
export async function applyAll(
  context,
  { items, run, describe, label = String }
) {
  const failures = [];

  for (const item of items) {
    try {
      context.log.info(describe(item, await run(item)));
    } catch (error) {
      failures.push(error);
      context.log.error(`${label(item)}: ${error.message}`);
    }
  }

  if (failures.length === 0) {
    return EXIT_CODES.SUCCESS;
  }

  context.log.error(
    `${failures.length} of ${items.length} operation(s) failed.`
  );
  return exitCodeForError(failures[0]);
}

/**
 * Print a value as JSON, used by the `--json` flag.
 * @param {Object} context - Run context
 * @param {any} value - Serializable value
 * @returns {number} Exit code
 */
export function printJson(context, value) {
  context.log.info(JSON.stringify(value, null, 2));
  return EXIT_CODES.SUCCESS;
}
