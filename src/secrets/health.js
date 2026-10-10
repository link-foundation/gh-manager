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
import { pollUntil } from '../verification.js';
import { secretName } from './api.js';
import { workflowFiles, workflowUsage, workflowSource } from './workflows.js';

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
    ).map((repo) => repositoryTarget(repo.full_name));
  }

  async inventory(name, options) {
    const items = [];
    for (const repo of await this.targets(options)) {
      try {
        for (const workflow of await workflowFiles(
          this.rest,
          repo,
          options.branch
        )) {
          const usage = workflowUsage(workflow.source, name);
          if (usage.jobs.length) {
            items.push({ repo, ...workflow, usage });
          }
        }
      } catch (error) {
        // No speculative success on missing permissions or malformed YAML.
        if (error.status === 401 || error.status === 403) {
          throw error;
        }
        items.push({ repo, unreadable: true });
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
      usage = workflowUsage(
        await workflowSource(this.rest, item.repo, item.file, run.head_sha),
        name
      );
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
      if (!matching.length || definition.reusable || ambiguous) {
        evidence.push({
          ...location,
          job: definition.name,
          status: 'unknown',
          reason: 'job-use-unresolved',
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
    const [match] = matchingLines(stepLines(await log(), step), patterns);
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
    } catch {
      return [
        {
          repository: repoSlug(item.repo),
          workflow: item.file,
          runId: run?.id,
          runUrl: run?.html_url,
          status: 'unknown',
          reason: 'evidence-unreadable',
        },
      ];
    }
  }

  async collect(name, options, inspect) {
    name = secretName(name);
    const patterns = [...AUTH_PATTERNS, ...(options.failurePatterns ?? [])];
    expressions(patterns);
    const evidence = [];
    for (const item of await this.inventory(name, options)) {
      if (item.unreadable) {
        evidence.push({
          repository: repoSlug(item.repo),
          status: 'unknown',
          reason: 'workflow-unreadable',
        });
      } else {
        evidence.push(...(await inspect(name, item, patterns)));
      }
    }
    return summary(name, evidence);
  }

  async latestRun(item, options) {
    const [run] = await this.runs.list(item.repo, {
      workflow: item.file,
      branch: options.branch,
      limit: 1,
    });
    return run;
  }

  health(name, options = {}) {
    return this.collect(name, options, async (normalized, item, patterns) =>
      this.safelyClassify(
        normalized,
        item,
        await this.latestRun(item, options),
        patterns
      )
    );
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
