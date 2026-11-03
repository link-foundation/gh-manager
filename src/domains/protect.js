import { readFile } from 'node:fs/promises';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { parseRepoSpec } from '../github/repo.js';
import { createRulesetDrift } from '../protection/drift.js';
import { createProtectionManager } from '../protection/manager.js';
import { flagRule } from '../protection/policy.js';
import { isScopedDocument } from '../protection/scoped.js';
import { printJson } from './targets.js';

function selectedRepository(context) {
  const repo = parseRepoSpec(context.targets[0], {
    defaultOwner: () => context.owner(),
  });
  if (
    context.flags.org &&
    repo.owner.toLowerCase() !== context.flags.org.toLowerCase()
  ) {
    throw new CliError(
      'The repository owner must match --org.',
      EXIT_CODES.USAGE
    );
  }
  return { repo };
}

function resolveTarget(context) {
  const { flags, targets } = context;
  const userCount = flags.users?.length ?? 0;
  if (
    flags.pattern ||
    flags.all ||
    flags.repo ||
    userCount > 1 ||
    (flags.org && userCount) ||
    targets.length > 1 ||
    (targets.length && userCount)
  ) {
    throw new CliError(
      'Protect one repository, --org <organization>, or --user <login>; these selections cannot be combined.',
      EXIT_CODES.USAGE
    );
  }
  if (targets.length) {
    return selectedRepository(context);
  }
  return flags.org
    ? { org: flags.org }
    : userCount
      ? { user: flags.users[0] }
      : {};
}

function showPlan(context, plan) {
  const show = context.flags.json ? context.log.debug : context.log.info;
  if (plan.fallbackReason) {
    context.log.warn(
      `Organization ruleset unavailable; falling back per repository: ${plan.fallbackReason}`
    );
  }
  show(`Resolved ${plan.repositories.length} repository(ies):`);
  const entries = [
    ...(plan.organization
      ? [
          {
            repository: `organization ${plan.target.org}`,
            ...plan.organization,
          },
        ]
      : []),
    ...plan.repositories,
  ];
  for (const entry of entries) {
    show(
      `  - ${entry.repository}: ${entry.action}${entry.fork ? ' (fork)' : ''}${entry.route ? ` via ${entry.route}` : ''}${entry.reason ? `; ${entry.reason}` : ''}`
    );
    if (entry.before && entry.after) {
      show(
        `    diff: ${JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}`
      );
    }
    if (entry.branches) {
      show(`    ${entry.limitation}`);
      for (const branch of entry.branches) {
        show(
          `    ${branch.branch}: ${branch.action}${branch.action === 'update' ? `; diff: ${JSON.stringify({ before: branch.before, after: branch.after })}` : ''}`
        );
      }
    }
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new CliError(
      `Cannot read ${label}: ${error.message}`,
      EXIT_CODES.USAGE
    );
  }
}

/** Human-readable summary of a scoped required-check drift plan. */
export function showDriftPlan(log, plan) {
  log.info(
    `${plan.repository} ${plan.branch} (head ${plan.headSha}): ${plan.action}${plan.ruleset ? ` ruleset ${plan.ruleset.id} "${plan.ruleset.name}"` : ''}${plan.reason ? `; ${plan.reason}` : ''}`
  );
  if (plan.checks) {
    log.info(
      `  required checks: ${plan.checks.effective.length} effective, missing ${plan.checks.missing.join(', ') || 'none'}${plan.checks.wrongIntegration.length ? `, wrong app ${plan.checks.wrongIntegration.join(', ')}` : ''}`
    );
  }
  for (const item of plan.findings) {
    log.info(
      `  ${item.setting}${item.context ? ` ${item.context}` : ''}: ${item.current} -> ${item.required}; ${item.resolved ? 'fixed and verified' : item.fixable ? 'fix planned' : 'manual action required'}${item.reason ? `; ${item.reason}` : ''}`
    );
  }
  for (const warning of plan.warnings) {
    log.warn(`  ${warning}`);
  }
  for (const change of plan.changes) {
    log.info(`  change: ${change}`);
  }
  for (const conflict of plan.conflicts) {
    log.warn(`  kept stronger or different existing setting: ${conflict}`);
  }
  if (plan.before && plan.after) {
    log.info(
      `  diff: ${JSON.stringify({ before: plan.before, after: plan.after }, null, 2)}`
    );
  }
  if (plan.fallback) {
    log.info(
      `  without Administration permission apply it in ${plan.fallback.browser} or with ${plan.fallback.api}`
    );
  }
}

/**
 * Audit one branch against a reviewed scoped ruleset document and repair the
 * existing repository ruleset without widening or weakening it.
 */
async function protectScoped(context, target, document) {
  const { flags } = context;
  if (!target.repo) {
    throw new CliError(
      'A scoped policy (with conditions) audits one repository; pass <owner>/<repo>.',
      EXIT_CODES.USAGE
    );
  }
  if (flags.name || flags.rules?.length) {
    throw new CliError(
      'Scoped policies take their name and rules from --from; drop --name and --rule.',
      EXIT_CODES.USAGE
    );
  }
  const savedPlan = flags.plan
    ? await readJson(flags.plan, 'saved plan')
    : undefined;
  const drift = createRulesetDrift({
    rest: context.rest,
    log: context.log,
    ...(flags.timeout !== undefined
      ? { verificationTimeout: flags.timeout * 1000 }
      : {}),
  });
  const plan = await drift.plan(target.repo, document, {
    branch: flags.branch,
    rulesetId: flags.ruleset,
  });
  if (flags.dryRun) {
    if (flags.json) {
      printJson(context, { dryRun: true, ...plan });
    } else {
      showDriftPlan(context.log, plan);
      context.log.info('Dry run: nothing was changed.');
    }
    return EXIT_CODES.SUCCESS;
  }
  if (!flags.json) {
    showDriftPlan(context.log, plan);
  }
  const result = await drift.apply(plan, document, {
    savedPlan,
    confirm: (reviewed) =>
      context.confirm(
        `${flags.json ? `${JSON.stringify({ before: reviewed.before, after: reviewed.after, changes: reviewed.changes }, null, 2)}\n` : ''}Apply ${reviewed.changes.length} ruleset change(s) to ${reviewed.repository}${reviewed.ruleset ? ` ruleset ${reviewed.ruleset.id}` : ''}?`
      ),
  });
  if (flags.json) {
    printJson(context, result);
  } else if (result.changed) {
    context.log.info(
      `${result.repository}: ${result.action} ruleset ${result.id} verified; ${result.readBack.effectiveChecks.length} required checks effective on ${result.branch}.`
    );
  } else {
    (result.action === 'failed' ? context.log.error : context.log.info)(
      `${result.repository}: ${result.action}${result.reason ? `; ${result.reason}` : ''}`
    );
  }
  if (result.exitCode) {
    return result.exitCode;
  }
  return result.action === 'blocked' ? EXIT_CODES.FAILURE : EXIT_CODES.SUCCESS;
}

async function protect(context) {
  const target = resolveTarget(context);
  const document = context.flags.from
    ? await readJson(context.flags.from, 'protection policy')
    : undefined;
  if (isScopedDocument(document)) {
    return protectScoped(context, target, document);
  }
  const manager = createProtectionManager({
    rest: context.rest,
    log: context.log,
    ...(context.flags.timeout !== undefined
      ? { verificationTimeout: context.flags.timeout * 1000 }
      : {}),
  });
  const result = await manager.protect(target, {
    name: context.flags.name,
    rules: (context.flags.rules ?? []).map(flagRule),
    document,
    dryRun: Boolean(context.flags.dryRun),
    onPlan: (plan) => showPlan(context, plan),
    confirm: (plan) => {
      const question = `Proceed with protection changes for ${plan.repositories.length} repository(ies)?`;
      return context.confirm(
        context.flags.json
          ? `${JSON.stringify({ organization: plan.organization, repositories: plan.repositories }, null, 2)}\n${question}`
          : question
      );
    },
  });
  if (context.flags.json) {
    printJson(context, result);
  } else if (result.dryRun) {
    context.log.info('Dry run: nothing was changed.');
  } else {
    for (const entry of result.repositories) {
      const show =
        entry.action === 'failed' ? context.log.error : context.log.info;
      show(
        `${entry.repository}: ${entry.action}${entry.verified ? ' (verified through the API)' : ''}${entry.reason ? `; ${entry.reason}` : ''}${entry.limitation ? `; ${entry.limitation}` : ''}`
      );
    }
  }
  return (
    result.repositories.find((entry) => entry.action === 'failed')?.exitCode ??
    EXIT_CODES.SUCCESS
  );
}

export const protectDomain = {
  name: 'protect',
  summary: 'Protect every branch against deletion and force pushes',
  defaultVerb: 'apply',
  usage: [
    'gh-manager protect <owner>/<repo> [--dry-run] [--yes]',
    'gh-manager protect --org <organization> [--dry-run] [--yes]',
    'gh-manager protect --user <login> [--dry-run] [--yes]',
    'gh-manager protect <owner>/<repo> --name protection --rule pull_request',
    'gh-manager protect <owner>/<repo> --from rules.json',
    'gh-manager protect <owner>/<repo> --from .github/main-ruleset.json [--branch main] [--ruleset <id>] --dry-run --json > plan.json',
    'gh-manager protect <owner>/<repo> --from .github/main-ruleset.json --plan plan.json [--yes]',
    '',
    'Defaults: active all-branch ruleset "protection", restrict deletions, block force pushes, no bypass actors.',
    'Organization rulesets cover future repositories; classic fallback covers current branches only.',
    'Bulk runs and named ruleset updates ask for confirmation; --yes confirms non-interactively.',
    'A --from document with conditions is a reviewed scoped ruleset: required-check drift on the selected branch is audited and the',
    'existing repository ruleset is repaired in place, keeping its coverage, bypass actors, stronger rules and app bindings.',
  ],
  verbs: {
    apply: { summary: 'Plan, confirm and apply protections', run: protect },
  },
};
