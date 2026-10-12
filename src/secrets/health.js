import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';
import { repoSlug } from '../github/repo.js';
import {
  repositoryTarget,
  selectedTargets,
  expressions,
  matchingLines,
} from '../github/discovery.js';
import { createRepoManager } from '../github/repos.js';
import { createRunManager } from '../github/runs.js';
import {
  expiredRun,
  unavailableLogs,
  validateRetentionDays,
} from '../github/logs.js';
import { pollUntil } from '../verification.js';
import { secretName } from './api.js';
import { workflowFiles, workflowSource } from './workflows.js';
import { resolvedWorkflowUsage } from './reusable.js';
import { healthExpiry, rotationWindow } from './expiry.js';

const AUTH_PATTERNS = [
  '\\b401\\b',
  '\\b403\\b',
  'unauthorized',
  'bad credentials',
  'expired',
  'invalid token',
];

function summary(name, evidence) {
  const status = evidence.some((item) => item.status === 'auth-failing')
    ? 'auth-failing'
    : evidence.length && evidence.every((item) => item.status === 'ok')
      ? 'ok'
      : 'unknown';
  return { name, status, evidence };
}

function withExpiry(result, expiry, log) {
  const warnings =
    expiry.status === 'unknown' && expiry.scope?.org
      ? [
          expiry.reason === 'expiry-absent'
            ? `Expiry unknown; record it with secret set ${result.name} --org ${expiry.scope.org} --expires-at <ISO-date>.`
            : `Expiry unknown: ${expiry.reason} for ${result.name}_EXPIRES_AT.`,
        ]
      : [];
  for (const warning of warnings) {
    log?.progress?.(warning);
  }
  return {
    ...result,
    status:
      expiry.status === 'expired'
        ? 'expired'
        : result.status === 'auth-failing'
          ? 'auth-failing'
          : expiry.status === 'expiring'
            ? 'expiring'
            : result.status,
    expiresAt: expiry.expiresAt ?? null,
    expiry,
    warnings,
  };
}

function unresolvedReason(definition, jobs) {
  const skipped = definition.callers?.some((caller) =>
    jobs.some(
      (job) => matchesName(caller, job.name) && job.conclusion === 'skipped'
    )
  );
  return skipped
    ? 'workflow-call-not-executed'
    : (definition.unresolvedReason ?? 'job-use-unresolved');
}

function matchesName(pattern, actual) {
  if (pattern === actual) {
    return true;
  }
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\$\\\{\\\{.*?\\\}\\\}/g, '.*');
  return new RegExp(`^${source}(?: \\(.*\\))?$`).test(actual);
}

function stepLines(source, step) {
  const start = Date.parse(step.started_at);
  const end = Date.parse(step.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return '';
  }
  // Retain newlines so evidence line numbers refer to the original job log.
  return source
    .split(/\r?\n/)
    .map((line) => {
      const time = Date.parse(line.match(/^\S+/)?.[0]);
      return time >= start && time <= end ? line : '';
    })
    .join('\n');
}

class SecretHealthService {
  constructor(options) {
    Object.assign(this, options);
    this.runs = createRunManager(options);
  }

  async targets({ scope, repos }) {
    if (scope?.repo && !scope.org && !scope.environment) {
      return [repositoryTarget(scope.repo)];
    }
    if (!scope?.org || scope.repo || scope.environment) {
      throw new CliError(
        'Health requires an org or repo scope.',
        EXIT_CODES.USAGE
      );
    }
    if (repos?.length) {
      return selectedTargets(scope.org, repos);
    }
    return (
      await createRepoManager({ rest: this.rest, log: this.log }).list({
        org: scope.org,
      })
    ).map((repo) => ({
      ...repositoryTarget(repo.full_name),
      default_branch: repo.default_branch,
    }));
  }

  async inventory(name, repo, options) {
    const items = [];
    const branch =
      options.branch ??
      repo.default_branch ??
      (await this.rest.request(repoPath(repo))).default_branch;
    if (!branch) {
      throw new CliError('GitHub did not return a default branch.');
    }
    for (const workflow of await workflowFiles(this.rest, repo, branch)) {
      const usage = await resolvedWorkflowUsage({
        rest: this.rest,
        repo,
        ...workflow,
        ref: branch,
        name,
        log: this.log,
      });
      if (usage.jobs.length) {
        items.push({ repo, ...workflow, usage, branch });
      }
    }
    return items;
  }

  async classify(name, item, run, patterns) {
    const location = {
      repository: repoSlug(item.repo),
      workflow: item.file,
      runId: run?.id,
      runUrl: run?.html_url,
    };
    if (!run) {
      return [{ ...location, status: 'unknown', reason: 'no-runs' }];
    }
    if (run.status !== 'completed') {
      return [{ ...location, status: 'unknown', reason: 'run-pending' }];
    }
    let usage = item.usage;
    if (run.head_sha) {
      usage = await resolvedWorkflowUsage({
        rest: this.rest,
        repo: item.repo,
        file: item.file,
        ref: run.head_sha,
        source: await workflowSource(
          this.rest,
          item.repo,
          item.file,
          run.head_sha
        ),
        name,
        recorded: run.referenced_workflows,
        pinned: true,
        log: this.log,
      });
    }
    const jobs = await this.runs.jobs(item.repo, run.id);
    const evidence = [];
    for (const definition of usage.jobs) {
      const matching = jobs.filter((job) =>
        matchesName(definition.name, job.name)
      );
      const ambiguous = matching.some(
        (job) =>
          usage.jobNames.filter((name) => matchesName(name, job.name))
            .length !== 1
      );
      if (
        !matching.length ||
        definition.reusable ||
        ambiguous ||
        (definition.called && !run.head_sha)
      ) {
        evidence.push({
          ...location,
          job: definition.name,
          status: 'unknown',
          reason: unresolvedReason(definition, jobs),
        });
        continue;
      }
      for (const job of matching) {
        evidence.push(
          ...(await this.classifyJob(item, definition, job, location, patterns))
        );
      }
    }

    return evidence.length
      ? evidence
      : [{ ...location, status: 'unknown', reason: 'secret-not-used-in-run' }];
  }

  async classifyJob(item, definition, job, location, patterns) {
    if (job.conclusion === 'skipped' || job.conclusion === 'cancelled') {
      return [
        {
          ...location,
          job: job.name,
          jobId: job.id,
          status: 'unknown',
          reason: 'job-not-executed',
        },
      ];
    }
    if (!definition.steps.length) {
      return [
        {
          ...location,
          job: job.name,
          status: 'unknown',
          reason: 'step-use-unresolved',
        },
      ];
    }
    let source;
    const log = async () => {
      source ??= await this.runs.jobLog(item.repo, job.id);
      return source;
    };
    const evidence = [];
    for (const selected of definition.steps) {
      const steps = (job.steps ?? []).filter((step) =>
        matchesName(selected.name, step.name)
      );
      const detail = {
        ...location,
        job: job.name,
        jobId: job.id,
        step: selected.name,
      };
      if (steps.length !== 1) {
        evidence.push({
          ...detail,
          status: 'unknown',
          reason: 'step-use-unresolved',
        });
        continue;
      }
      evidence.push(
        await this.classifyStep(
          { ...detail, stepNumber: steps[0].number },
          steps[0],
          log,
          patterns
        )
      );
    }
    return evidence;
  }

  async classifyStep(detail, step, log, patterns) {
    if (step.status === 'completed' && step.conclusion === 'success') {
      return { ...detail, status: 'ok' };
    }
    if (step.conclusion !== 'failure') {
      return { ...detail, status: 'unknown', reason: 'step-not-executed' };
    }
    const source = await log();
    if (typeof source !== 'string') {
      return { ...detail, status: 'unknown', reason: source.status };
    }
    const [match] = matchingLines(stepLines(source, step), patterns);
    return match
      ? { ...detail, status: 'auth-failing', match }
      : {
          ...detail,
          status: 'unknown',
          reason: 'failure-without-auth-evidence',
        };
  }

  async safelyClassify(name, item, run, patterns) {
    try {
      return await this.classify(name, item, run, patterns);
    } catch (error) {
      const unavailable = /\/actions\/runs\/\d+\/jobs(?:\?|$)/.test(
        error.path ?? ''
      )
        ? unavailableLogs(error.status, error.path)
        : null;
      return [
        {
          repository: repoSlug(item.repo),
          workflow: item.file,
          runId: run?.id,
          runUrl: run?.html_url,
          status: 'unknown',
          reason: unavailable?.status ?? 'evidence-unreadable',
          ...(unavailable ? {} : { error: error.message }),
        },
      ];
    }
  }

  async collect(name, options, inspect) {
    name = secretName(name);
    const patterns = [...AUTH_PATTERNS, ...(options.failurePatterns ?? [])];
    expressions(patterns);
    validateRetentionDays(options.retentionDays ?? 90);
    rotationWindow(options);
    const evidence = [];
    const repos = await this.targets(options);
    for (const [index, repo] of repos.entries()) {
      this.log?.progress?.(
        `${index}/${repos.length} repositories: scanning ${repoSlug(repo)}`
      );
      try {
        for (const item of await this.inventory(name, repo, options)) {
          try {
            evidence.push(...(await inspect(name, item, patterns)));
          } catch (error) {
            evidence.push({
              repository: repoSlug(repo),
              workflow: item.file,
              status: 'unknown',
              reason: 'repository-error',
              error: error.message,
            });
          }
        }
      } catch (error) {
        evidence.push({
          repository: repoSlug(repo),
          status: 'unknown',
          reason: 'workflow-unreadable',
          error: error.message,
        });
      }
    }
    const errors = new Set(
      evidence.filter((item) => item.error).map((item) => item.repository)
    ).size;
    this.log?.progress?.(
      `${repos.length}/${repos.length} repositories complete; ${errors} repository error(s).`
    );
    const result = summary(name, evidence);
    const expiry = await healthExpiry(
      this.rest,
      name,
      options,
      this.now ?? Date.now
    );
    return withExpiry(result, expiry, this.log);
  }

  async latestRun(item, options) {
    const [run] = await this.runs.list(item.repo, {
      workflow: item.file,
      branch: options.branch ?? item.branch,
      limit: 1,
    });
    return run;
  }

  health(name, options = {}) {
    return this.collect(name, options, async (normalized, item, patterns) => {
      const run = await this.latestRun(item, options);
      if (
        run?.status === 'completed' &&
        expiredRun(run, options.retentionDays ?? 90, this.now ?? Date.now)
      ) {
        return [
          {
            repository: repoSlug(item.repo),
            workflow: item.file,
            runId: run.id,
            runUrl: run.html_url,
            status: 'unknown',
            reason: 'logs-expired',
          },
        ];
      }
      return this.safelyClassify(normalized, item, run, patterns);
    });
  }
  async trigger(item, previous, options) {
    const base = `${repoPath(item.repo)}/actions`;
    if (!item.usage.dispatch) {
      if (!previous) {
        return null;
      }
      await this.rest.request(`${base}/runs/${previous.id}/rerun`, {
        method: 'POST',
      });
      return async () => {
        const current = await this.runs.get(item.repo, previous.id);
        return (current.run_attempt ?? 1) > (previous.run_attempt ?? 1)
          ? current
          : null;
      };
    }
    const ref =
      options.branch ??
      item.branch ??
      (await this.rest.request(repoPath(item.repo))).default_branch;
    const dispatched = await this.rest.request(
      `${base}/workflows/${encodeURIComponent(item.file)}/dispatches`,
      { method: 'POST', body: { ref, inputs: options.inputs ?? {} } }
    );
    return async () => {
      if (dispatched?.workflow_run_id) {
        return this.runs.get(item.repo, dispatched.workflow_run_id);
      }
      const recent = await this.runs.list(item.repo, {
        workflow: item.file,
        branch: ref,
        event: 'workflow_dispatch',
      });
      return recent.find((run) => run.id > (previous?.id ?? 0)) ?? null;
    };
  }

  async test(name, options = {}) {
    name = secretName(name);
    const timeout = options.timeout ?? 300000;
    const interval = options.interval ?? 1000;
    if (
      !Number.isFinite(timeout) ||
      timeout < 0 ||
      !Number.isFinite(interval) ||
      interval < 0
    ) {
      throw new CliError(
        'Test polling durations must be nonnegative.',
        EXIT_CODES.USAGE
      );
    }
    return await this.collect(name, options, (normalized, item, patterns) =>
      this.testWorkflow(normalized, item, patterns, {
        ...options,
        timeout,
        interval,
      })
    );
  }

  async testWorkflow(name, item, patterns, options) {
    const previous = await this.latestRun(item, options);
    const read = await this.trigger(item, previous, options);
    const location = { repository: repoSlug(item.repo), workflow: item.file };
    if (!read) {
      return [
        {
          ...location,
          status: 'unknown',
          reason: 'workflow-cannot-be-triggered',
        },
      ];
    }
    const outcome = await pollUntil({
      timeout: options.timeout,
      interval: options.interval,
      now: this.now,
      sleep: this.sleep,
      read,
      accept: (run) => run?.status === 'completed',
    });
    if (!outcome.accepted) {
      return [
        {
          ...location,
          runId: outcome.value?.id,
          runUrl: outcome.value?.html_url,
          status: 'unknown',
          reason: 'test-timeout',
        },
      ];
    }
    return this.safelyClassify(name, item, outcome.value, patterns);
  }
}

/** Stable secret health service: GitHub workflow evidence only. */
export function createSecretHealth(options = {}) {
  return new SecretHealthService(options);
}
