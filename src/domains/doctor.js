import { readFile } from 'node:fs/promises';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { createDoctor } from '../doctor/manager.js';
import { isScopedDocument } from '../protection/scoped.js';
import { printJson } from './targets.js';

/** Read the reviewed scoped ruleset document passed with --from. */
async function readPolicy(path) {
  if (!path) {
    return undefined;
  }
  let document;
  try {
    document = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new CliError(
      `Cannot read protection policy: ${error.message}`,
      EXIT_CODES.USAGE
    );
  }
  if (!isScopedDocument(document)) {
    throw new CliError(
      'Doctor --from expects a reviewed ruleset document with conditions.ref_name.',
      EXIT_CODES.USAGE
    );
  }
  return document;
}

function evidenceLine(evidence) {
  const where = evidence.file ?? evidence.runUrl ?? evidence.sha;
  return `${where}${evidence.line === undefined ? '' : `:${evidence.line}`}: ${evidence.text}`;
}

async function diagnose(context) {
  const { flags, targets } = context;
  if (targets.length > 1 || (flags.users?.length ?? 0) > 1) {
    throw new CliError(
      'Select one repository, --org, or --user.',
      EXIT_CODES.USAGE
    );
  }
  const policy = await readPolicy(flags.from);
  if (!policy && (flags.branch || flags.ruleset !== undefined)) {
    throw new CliError(
      '--branch and --ruleset need --from <reviewed ruleset>.',
      EXIT_CODES.USAGE
    );
  }
  const doctor = createDoctor({
    rest: context.rest,
    log: context.log,
    getSession: context.getSession,
    security: (repo) => context.security(repo),
  });
  const result = await doctor.scan(
    { repo: targets[0], org: flags.org, user: flags.users?.[0] },
    {
      fix: Boolean(flags.fix),
      dryRun: Boolean(flags.dryRun),
      rerun: flags.rerun !== false,
      policy,
      branch: flags.branch,
      rulesetId: flags.ruleset,
      confirm: (plan) =>
        context.confirm(
          `${JSON.stringify(plan, null, 2)}\nApply these ${plan.length} verified settings repairs${flags.rerun === false ? '' : ' and rerun affected failed workflows'}?`
        ),
    }
  );
  if (flags.json) {
    printJson(context, result);
  } else {
    for (const entry of result.repositories) {
      context.log.info(entry.repository);
      for (const finding of entry.findings) {
        context.log.info(
          `  ${finding.setting}${finding.context ? ` ${finding.context}` : ''}: ${finding.current} -> ${finding.required}; ${finding.resolved ? 'fixed and verified' : finding.fixable ? 'fix available' : 'manual action required'}${finding.reason ? `; ${finding.reason}` : ''}${finding.error ? `; ${finding.error}` : ''}`
        );
        for (const evidence of finding.evidence) {
          context.log.info(`    ${evidenceLine(evidence)}`);
        }
      }
      for (const warning of entry.branchRules?.warnings ?? []) {
        context.log.warn(`  ${warning}`);
      }
      for (const error of entry.errors) {
        context.log.error(`  ${error.error ?? error.reason}`);
      }
      for (const run of entry.reruns) {
        context.log.info(`  Run ${run.runId}: ${run.status}`);
      }
    }
    context.log.info(
      `${result.remaining} unresolved finding(s) or scan error(s).${result.dryRun ? ' Dry run: nothing was changed.' : ''}`
    );
  }
  return result.exitCode;
}
export const doctorDomain = {
  name: 'doctor',
  summary: 'Diagnose CI repository settings from workflows and failing logs',
  defaultVerb: 'scan',
  usage: [
    'gh-manager doctor <owner>/<repo> [--fix --yes] [--no-rerun] [--dry-run] [--json]',
    'gh-manager doctor --user <login>',
    'gh-manager doctor --org <organization> [--fix --yes]',
    'gh-manager doctor <owner>/<repo> --from .github/main-ruleset.json [--branch main] [--ruleset <id>] [--fix --yes]',
    '',
    '--from compares a reviewed scoped ruleset with the effective repository, organization and classic rules on the branch;',
    'missing or mis-bound required checks become findings and --fix repairs the existing ruleset without widening its scope.',
    'Ruleset repairs never rerun workflows.',
  ],
  verbs: {
    scan: {
      summary: 'Report settings required by CI and optionally repair them',
      run: diagnose,
    },
  },
};
