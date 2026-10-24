import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repositoryTarget } from '../github/discovery.js';
import { repoSlug } from '../github/repo.js';
import { createRepoManager } from '../github/repos.js';
import { createRunManager } from '../github/runs.js';
import { createPagesManager } from '../pages/manager.js';
import { createSecurityGateway } from '../security/gateway.js';
import { inspectRepository } from './inspect.js';
import { repairRepository } from './repair.js';

/** Read-only diagnosis followed by optional, individually verified repairs. */
export function createDoctor({
  rest,
  log = { debug: () => {} },
  getSession,
  security,
  repos = createRepoManager({ rest, log }),
  runs = createRunManager({ rest, log }),
  pages = createPagesManager({ rest }),
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
      for (const target of targets) {
        try {
          report.repositories.push(
            await inspectRepository(target, {
              rest,
              log,
              repos,
              runs,
              pages,
              gateway,
            })
          );
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
