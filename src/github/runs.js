import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from './rest.js';
import { repoSlug } from './repo.js';
import {
  pages,
  repositoryTarget,
  expressions,
  matchingLines,
} from './discovery.js';
import { createRepoManager } from './repos.js';
import { expiredRun, unavailableLogs, validateRetentionDays } from './logs.js';
import { failureReport } from './failure-report.js';

function runTarget(run, repo) {
  const url = String(run).match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/?$/
  );
  const id = Number(url ? url[3] : run);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new CliError(
      'Supply a positive run ID or GitHub Actions run URL.',
      EXIT_CODES.USAGE
    );
  }
  return { id, repo: repositoryTarget(url ? `${url[1]}/${url[2]}` : repo) };
}

/** Stable Actions discovery service. Log results contain matched, redacted lines. */
export function createRunManager({ rest, log, now = Date.now } = {}) {
  const manager = {
    list(target, { workflow, branch, status, event, limit } = {}) {
      const base = `${repoPath(repositoryTarget(target))}/actions`;
      const path = workflow
        ? `${base}/workflows/${encodeURIComponent(workflow.replace(/^\.github\/workflows\//, ''))}/runs`
        : `${base}/runs`;
      const query = Object.fromEntries(
        Object.entries({ branch, status, event }).filter(
          ([, value]) => value !== undefined
        )
      );
      log?.debug(`runs API: GET ${path}`);
      return pages(rest, path, 'workflow_runs', { query, limit });
    },
    get(target, id) {
      return rest.request(
        `${repoPath(repositoryTarget(target))}/actions/runs/${id}`
      );
    },
    jobs(target, id) {
      return pages(
        rest,
        `${repoPath(repositoryTarget(target))}/actions/runs/${id}/jobs`,
        'jobs',
        { query: { filter: 'latest' } }
      );
    },
    jobLog(target, id) {
      const path = `${repoPath(repositoryTarget(target))}/actions/jobs/${id}/logs`;
      log?.debug(`runs API: GET ${path}`);
      return rest.text(path);
    },
    async logs(run, { repo, grep = [] } = {}) {
      expressions(grep);
      const target = runTarget(run, repo);
      const runUrl = `https://github.com/${repoSlug(target.repo)}/actions/runs/${target.id}`;
      const lines = [];
      const location = {
        repository: repoSlug(target.repo),
        runId: target.id,
        runUrl,
      };
      let jobs;
      try {
        jobs = await manager.jobs(target.repo, target.id);
      } catch (error) {
        const unavailable = unavailableLogs(error.status, error.path);
        if (!unavailable) {
          throw error;
        }
        return [{ ...location, ...unavailable, url: runUrl }];
      }
      for (const job of jobs) {
        const source = await manager.jobLog(target.repo, job.id);
        if (typeof source !== 'string') {
          lines.push({
            ...location,
            ...source,
            url: runUrl,
            jobId: job.id,
            job: job.name,
          });
          continue;
        }
        for (const line of matchingLines(source, grep)) {
          lines.push({
            repository: repoSlug(target.repo),
            runId: target.id,
            runUrl,
            jobId: job.id,
            job: job.name,
            ...line,
          });
        }
      }
      return lines;
    },
    async failures(options) {
      return (await scanFailures(manager, { rest, log, now }, options))
        .findings;
    },
    async failureReport(options) {
      const { findings, repos } = await scanFailures(
        manager,
        { rest, log, now },
        options
      );
      return failureReport(findings, repos);
    },
  };
  return manager;
}

async function workflowFailure(manager, target, workflow, options) {
  const { branch, grep, retentionDays, now } = options;
  const [latest] = await manager.list(target, {
    workflow: workflow.path ?? String(workflow.id),
    branch,
    limit: 1,
  });
  if (latest?.conclusion !== 'failure') {
    return null;
  }
  const location = {
    repository: repoSlug(target),
    workflow: workflow.path,
    runId: latest.id,
    runUrl: latest.html_url,
  };
  if (expiredRun(latest, retentionDays, now)) {
    return {
      ...location,
      status: 'unknown',
      reason: 'logs-expired',
      matches: [],
    };
  }
  const results = await manager.logs(latest.id, { repo: target, grep });
  const missing = results.filter((entry) => entry.status);
  const matches = results.filter((entry) => !entry.status);
  if (!missing.length && !matches.length) {
    return null;
  }
  return {
    ...location,
    status: missing.length ? 'unknown' : 'failure',
    ...(missing.length
      ? { reason: missing[0].status, unavailableLogs: missing }
      : {}),
    matches,
  };
}

async function repositoryWorkflows(rest, repo) {
  const target = repositoryTarget(repo.full_name);
  const branch =
    repo.default_branch ??
    (await rest.request(repoPath(target))).default_branch;
  if (!branch) {
    throw new CliError('GitHub did not return a default branch.');
  }
  const workflows = await pages(
    rest,
    `${repoPath(target)}/actions/workflows`,
    'workflows'
  );
  return { target, branch, workflows };
}

async function scanFailures(
  manager,
  { rest, log, now },
  {
    org,
    grep = [],
    includeArchived = false,
    includeForks = false,
    retentionDays = 90,
  } = {}
) {
  expressions(grep);
  validateRetentionDays(retentionDays);
  const findings = [];
  const repos = await createRepoManager({ rest, log }).list({
    org,
    includeArchived,
    includeForks,
  });
  for (const [index, repo] of repos.entries()) {
    log?.progress?.(
      `${index}/${repos.length} repositories: scanning ${repo.full_name}`
    );
    try {
      const { target, branch, workflows } = await repositoryWorkflows(
        rest,
        repo
      );
      for (const workflow of workflows) {
        try {
          const finding = await workflowFailure(manager, target, workflow, {
            branch,
            grep,
            retentionDays,
            now,
          });
          if (finding) {
            findings.push(finding);
          }
        } catch (error) {
          findings.push({
            repository: repo.full_name,
            workflow: workflow.path,
            status: 'unknown',
            reason: 'repository-error',
            error: error.message,
          });
        }
      }
    } catch (error) {
      findings.push({
        repository: repo.full_name,
        status: 'unknown',
        reason: 'repository-error',
        error: error.message,
      });
    }
  }
  const errors = new Set(
    findings.filter((entry) => entry.error).map((entry) => entry.repository)
  ).size;
  log?.progress?.(
    `${repos.length}/${repos.length} repositories complete; ${errors} repository error(s).`
  );
  return { findings, repos };
}
