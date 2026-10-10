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
export function createRunManager({ rest, log } = {}) {
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
      for (const job of await manager.jobs(target.repo, target.id)) {
        const source = await manager.jobLog(target.repo, job.id);
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
    async failures({
      org,
      grep = [],
      includeArchived = false,
      includeForks = false,
    } = {}) {
      expressions(grep);
      const findings = [];
      const repos = await createRepoManager({ rest, log }).list({
        org,
        includeArchived,
        includeForks,
      });
      for (const repo of repos) {
        const target = repositoryTarget(repo.full_name);
        const [latest] = await manager.list(target, {
          branch: repo.default_branch,
          limit: 1,
        });
        if (latest?.conclusion !== 'failure') {
          continue;
        }
        const matches = await manager.logs(latest.id, { repo: target, grep });
        if (matches.length) {
          findings.push({
            repository: repo.full_name,
            runId: latest.id,
            runUrl: latest.html_url,
            matches,
          });
        }
      }
      return findings;
    },
  };
  return manager;
}
