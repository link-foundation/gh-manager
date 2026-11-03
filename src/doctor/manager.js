import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repositoryTarget } from '../github/discovery.js';
import { repoSlug } from '../github/repo.js';
import { createRepoManager } from '../github/repos.js';
import { createRunManager } from '../github/runs.js';
import { createPagesManager } from '../pages/manager.js';
import { createRulesetDrift } from '../protection/drift.js';
import { createSecurityGateway } from '../security/gateway.js';
import { inspectRepository } from './inspect.js';
import { repairRepository } from './repair.js';

/**
 * Compare the selected branch with a reviewed scoped ruleset and add the
 * required-check drift as findings with source `branch-rules`.
 */
async function auditBranchRules(entry, target, options) {
  const { drift, policy, branch, rulesetId, plans } = options;
  try {
    const plan = await drift.plan(repositoryTarget(target), policy, {
      branch,
      rulesetId,
    });
    entry.branchRules = {
      branch: plan.branch,
      headSha: plan.headSha,
      action: plan.action,
      ruleset: plan.ruleset,
      checks: plan.checks,
      changes: plan.changes,
      warnings: plan.warnings,
      fallback: plan.fallback,
    };
    entry.findings.push(...plan.findings);
    plans.set(entry.repository, plan);
  } catch (error) {
    // Keep the other findings of this repository; the scan continues.
    entry.errors.push({ source: 'branch-rules', error: error.message });
  }
}

/**
 * Apply the branch-rules plan of one repository. Ruleset changes never
 * request workflow reruns: stricter enforcement does not fix a failed run.
 */
async function repairBranchRules(entry, { drift, policy, plans }) {
  const plan = plans.get(entry.repository);
  if (!plan || !['update', 'create'].includes(plan.action)) {
    return;
  }
  try {
    const result = await drift.apply(plan, policy, { confirm: () => true });
    entry.branchRules.action = result.action;
    entry.branchRules.readBack = result.readBack;
    if (result.reason) {
      entry.errors.push({ error: result.reason });
    }
  } catch (error) {
    entry.errors.push({ error: error.message });
  }
}

/** Read-only diagnosis followed by optional, individually verified repairs. */
export function createDoctor({
  rest,
  log = { debug: () => {} },
  getSession,
  security,
  repos = createRepoManager({ rest, log }),
  runs = createRunManager({ rest, log }),
  pages = createPagesManager({ rest }),
  drift = createRulesetDrift({ rest, log }),
} = {}) {
  const gateway =
    security ??
    ((repo) => createSecurityGateway({ repo, rest, log, getSession }));

  return {
    async scan(
      { repo, org, user } = {},
      {
        fix = false,
        dryRun = false,
        rerun = true,
        confirm = () => false,
        includeArchived = true,
        includeForks = true,
        policy,
        branch,
        rulesetId,
      } = {}
    ) {
      if ([repo, org, user].filter(Boolean).length !== 1) {
        throw new CliError(
          'Doctor requires exactly one repository, --user, or --org.',
          EXIT_CODES.USAGE
        );
      }
      const targets = repo
        ? [repositoryTarget(repo)]
        : (await repos.list({ org, user, includeArchived, includeForks })).map(
            (item) => repositoryTarget(item.full_name)
          );
      const report = { repositories: [], dryRun, fix };
      const plans = new Map();
      for (const target of targets) {
        try {
          const entry = await inspectRepository(target, {
            rest,
            log,
            repos,
            runs,
            pages,
            gateway,
          });
          if (policy) {
            await auditBranchRules(entry, target, {
              drift,
              policy,
              branch,
              rulesetId,
              plans,
            });
          }
          report.repositories.push(entry);
        } catch (error) {
          report.repositories.push({
            repository: repoSlug(target),
            findings: [],
            errors: [{ error: error.message }],
            reruns: [],
          });
        }
      }
      const planned = report.repositories.flatMap((entry) =>
        entry.findings
          .filter((f) => f.fixable)
          .map((f) => ({ repository: entry.repository, ...f }))
      );
      if (fix && !dryRun && planned.length) {
        if (!(await confirm(planned))) {
          throw new CliError(
            'Aborted: nothing was changed.',
            EXIT_CODES.ABORTED
          );
        }
        for (const entry of report.repositories) {
          await repairBranchRules(entry, { drift, policy, plans });
          await repairRepository(entry, { rerun, gateway, pages, runs, rest });
        }
      }
      report.remaining = report.repositories.reduce(
        (sum, entry) =>
          sum +
          entry.findings.filter((f) => !f.resolved).length +
          entry.errors.length,
        0
      );
      report.exitCode = report.remaining
        ? EXIT_CODES.FAILURE
        : EXIT_CODES.SUCCESS;
      return report;
    },
  };
}
