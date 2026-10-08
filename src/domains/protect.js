import { readFile } from 'node:fs/promises';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { parseRepoSpec } from '../github/repo.js';
import { createProtectionManager } from '../protection/manager.js';
import { flagRule } from '../protection/policy.js';
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

async function protect(context) {
  const target = resolveTarget(context);
  let document;
  if (context.flags.from) {
    try {
      document = JSON.parse(await readFile(context.flags.from, 'utf8'));
    } catch (error) {
      throw new CliError(
        `Cannot read protection policy: ${error.message}`,
        EXIT_CODES.USAGE
      );
    }
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
    confirm: (plan) =>
      context.confirm(
        `Proceed with protection changes for ${plan.repositories.length} repository(ies)?`
      ),
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
    '',
    'Defaults: active all-branch ruleset "protection", restrict deletions, block force pushes, no bypass actors.',
    'Organization rulesets cover future repositories; classic fallback covers current branches only.',
    'Bulk runs and named ruleset updates ask for confirmation; --yes confirms non-interactively.',
  ],
  verbs: {
    apply: { summary: 'Plan, confirm and apply protections', run: protect },
  },
};
