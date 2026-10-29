import { readFile } from 'node:fs/promises';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { createRepairVerifier } from '../repair/manager.js';

async function verify(context) {
  if (context.targets.length !== 1) {
    throw new CliError(
      'Supply one repair evidence JSON file.',
      EXIT_CODES.USAGE
    );
  }
  let evidence;
  try {
    evidence = JSON.parse(await readFile(context.targets[0], 'utf8'));
  } catch {
    throw new CliError(
      'Could not read the repair evidence JSON file.',
      EXIT_CODES.USAGE
    );
  }
  const result = await createRepairVerifier({
    rest: context.rest,
    log: context.log,
  }).verify({
    ...evidence,
    dryRun: Boolean(context.flags.dryRun || evidence.dryRun),
    ...(context.flags.timeout === undefined
      ? {}
      : { timeout: context.flags.timeout * 1000 }),
  });
  context.log.info(JSON.stringify(result, null, context.flags.json ? 2 : 0));
  return ['success', 'skipped', 'dry-run'].includes(result.status)
    ? EXIT_CODES.SUCCESS
    : EXIT_CODES.VERIFICATION_FAILED;
}
export const repairDomain = {
  name: 'repair',
  summary:
    'Verify caller repairs against the affected CI and return final evidence',
  usage: [
    'gh-manager repair verify ./repair-evidence.json [--timeout seconds] [--dry-run] [--json]',
    'Evidence supplies repo, workflow, runId, jobIds and verified changes; workflow code changes also require revision { ref, sha }.',
    'Only the caller-selected workflow/jobs are restarted. A no-op never starts CI.',
  ],
  verbs: {
    verify: {
      summary: 'Start and monitor relevant CI after verified changes',
      run: verify,
    },
  },
};
