import { CliError, EXIT_CODES } from '../exit-codes.js';
import { createDoctor } from '../doctor/manager.js';
import { printJson } from './targets.js';

async function diagnose(context) {
  const { flags, targets } = context;
  if (targets.length > 1 || (flags.users?.length ?? 0) > 1) {
    throw new CliError(
      'Select one repository, --org, or --user.',
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
          `  ${finding.setting}: ${finding.current} -> ${finding.required}; ${finding.resolved ? 'fixed and verified' : finding.fixable ? 'fix available' : 'manual action required'}${finding.reason ? `; ${finding.reason}` : ''}${finding.error ? `; ${finding.error}` : ''}`
        );
        for (const evidence of finding.evidence) {
          context.log.info(
            `    ${evidence.file ?? evidence.runUrl}:${evidence.line}: ${evidence.text}`
          );
        }
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
  ],
  verbs: {
    scan: {
      summary: 'Report settings required by CI and optionally repair them',
      run: diagnose,
    },
  },
};
