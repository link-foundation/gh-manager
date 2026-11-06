import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repositoryTarget } from '../github/discovery.js';
import { repoPath } from '../github/rest.js';
import { repoSlug } from '../github/repo.js';
import { createRunManager } from '../github/runs.js';
import { delay } from '../verification.js';
import { JobsUnavailableError, validJob } from '../github/jobs.js';
import {
  repairInput,
  matchesWorkflow,
  validateRun,
  codePrerequisites,
} from './evidence.js';

function evidence(run, jobs = []) {
  return {
    runId: run?.id ?? null,
    runAttempt: run?.run_attempt ?? null,
    sha: run?.head_sha ?? null,
    conclusion: run?.conclusion ?? null,
    runUrl: run?.html_url ?? null,
    jobs: jobs.map(
      ({
        id,
        name,
        status,
        conclusion,
        html_url,
        steps,
        run_attempt,
        head_sha,
        discovery,
      }) => ({
        id,
        name,
        status,
        conclusion,
        url: html_url,
        steps,
        runAttempt: run_attempt ?? null,
        sha: head_sha ?? null,
        discovery,
      })
    ),
  };
}

/** Verify the caller-selected workflow and retain final CI evidence. */
class RepairVerifier {
  constructor({ rest, log, now = Date.now, sleep = delay }) {
    Object.assign(this, {
      rest,
      log,
      now,
      sleep,
      runs: createRunManager({ rest, log, sleep }),
    });
  }
  async waitFor(read, accept, deadline, interval) {
    let result = await read();
    while (!accept(result)) {
      if (this.now() >= deadline) {
        return { result, accepted: false };
      }
      await this.sleep(Math.min(interval, Math.max(0, deadline - this.now())));
      result = await read();
    }
    return { result, accepted: true };
  }
  async finish({
    repo,
    input,
    runId,
    previousAttempt,
    expectedSha,
    names,
    deadline,
  }) {
    const waited = await this.waitFor(
      async () => {
        const run = await this.runs.get(repo, runId);
        if (run.run_attempt <= previousAttempt || run.status !== 'completed') {
          return { run, jobs: [], stable: false };
        }
        const jobs = await this.runs.jobs(repo, runId, {
          attempt: run.run_attempt,
        });
        const after = await this.runs.get(repo, runId);
        const stable = [
          'id',
          'head_sha',
          'run_attempt',
          'status',
          'conclusion',
          'path',
        ].every((key) => after[key] === run[key]);
        return { run: after, jobs: stable ? jobs : [], stable };
      },
      ({ run, stable }) =>
        stable &&
        run.run_attempt > previousAttempt &&
        run.status === 'completed',
      deadline,
      input.interval
    );
    const { run, jobs } = waited.result;
    const final = evidence(run, jobs);
    if (!waited.accepted) {
      return { status: 'timeout', success: false, ...final };
    }
    if (run.head_sha !== expectedSha || !matchesWorkflow(run, input.workflow)) {
      return {
        status: 'verification-failed',
        success: false,
        reason: 'run-revision-or-workflow-mismatch',
        ...final,
      };
    }
    const successful =
      run.conclusion === 'success' &&
      jobs.every(
        (job) =>
          (job.run_attempt === undefined ||
            job.run_attempt === run.run_attempt) &&
          (job.head_sha === undefined || job.head_sha === run.head_sha)
      ) &&
      names.every((name) =>
        jobs.some(
          (job) =>
            job.name === name &&
            job.status === 'completed' &&
            job.conclusion === 'success'
        )
      );
    return {
      status: successful ? 'success' : 'failure',
      success: successful,
      ...final,
    };
  }

  async expectedSha(repo, input, run) {
    if (input.codeChanged) {
      const commit = await this.rest.request(
        `${repoPath(repo)}/commits/${encodeURIComponent(input.revision.ref)}`
      );
      if (commit?.sha !== input.revision.sha || commit.sha === run.head_sha) {
        throw new CliError(
          'The revision must resolve to the updated workflow SHA.',
          EXIT_CODES.VERIFICATION_FAILED
        );
      }
      return commit.sha;
    }
    if (input.revision && input.revision.sha !== run.head_sha) {
      throw new CliError(
        'A changed revision requires a verified workflow change.',
        EXIT_CODES.USAGE
      );
    }
    return run.head_sha;
  }
  async verify(options) {
    try {
      return await this.verifyAvailable(options);
    } catch (error) {
      if (!(error instanceof JobsUnavailableError)) {
        throw error;
      }
      return { workflow: options.workflow, ...error.evidence, success: false };
    }
  }
  async selectedJobs(repo, run, jobs, ids) {
    const selected = [];
    for (const id of ids) {
      let original = jobs.find((job) => job.id === id);
      if (!original) {
        try {
          original = await this.runs.job(repo, id);
        } catch (error) {
          if (error.status === 404) {
            throw new CliError(
              'Affected job evidence does not identify a failed job in this run.',
              EXIT_CODES.USAGE
            );
          }
          throw new JobsUnavailableError(
            repo,
            run.id,
            'selected-job-unavailable',
            run
          );
        }
        if (!validJob(original, repo, run, id)) {
          throw new JobsUnavailableError(
            repo,
            run.id,
            'selected-job-provenance-mismatch',
            run
          );
        }
      }
      const matching = jobs.filter((job) => job.name === original.name);
      if (matching.length !== 1) {
        throw new JobsUnavailableError(
          repo,
          run.id,
          'ambiguous-selected-job',
          run
        );
      }
      selected.push(matching[0]);
    }
    return [...new Map(selected.map((job) => [job.id, job])).values()];
  }
  async verifyAvailable(options) {
    const input = repairInput(options);
    const repo = repositoryTarget(input.repo);
    const location = { repository: repoSlug(repo), workflow: input.workflow };
    if (!input.changes.some((change) => change.changed)) {
      return {
        ...location,
        status: 'skipped',
        success: false,
        reason: 'no-changes',
      };
    }
    const deadline = this.now() + input.timeout;
    const waiting = await this.waitFor(
      () => this.runs.get(repo, input.runId),
      (run) => run.status === 'completed',
      deadline,
      input.interval
    );
    const run = waiting.result;
    if (!waiting.accepted) {
      return {
        ...location,
        status: 'timeout',
        success: false,
        reason: 'active-attempt',
        ...evidence(run),
      };
    }
    const jobs = await this.runs.jobs(repo, input.runId);
    const selected = (
      await this.selectedJobs(repo, run, jobs, input.jobIds)
    ).filter((job) => job.conclusion !== 'success');
    if (!selected.length) {
      return {
        ...location,
        status: 'skipped',
        success: false,
        reason: 'jobs-no-longer-failed',
        ...evidence(run, jobs),
      };
    }
    if (
      !validateRun(run, jobs, {
        ...input,
        jobIds: selected.map((job) => job.id),
      })
    ) {
      return {
        ...location,
        status: 'skipped',
        success: false,
        reason: 'run-no-longer-failed',
        ...evidence(run, jobs),
      };
    }
    const names = selected.map((job) => job.name);
    const expectedSha = await this.expectedSha(repo, input, run);
    const prerequisites = await codePrerequisites(
      this.rest,
      repo,
      input,
      expectedSha
    );
    const noTrigger =
      input.codeChanged && !prerequisites.dispatch && !input.newRunId;
    if (prerequisites.missing.length || noTrigger) {
      return {
        ...location,
        status: 'prerequisite',
        success: false,
        prerequisites: prerequisites.missing,
        reason: noTrigger
          ? 'new-revision-needs-workflow-dispatch-or-caller-started-run'
          : 'workflow-job-permissions',
      };
    }
    if (input.dryRun) {
      return {
        ...location,
        status: 'dry-run',
        success: false,
        sha: expectedSha,
        operation: input.newRunId
          ? 'monitor'
          : input.codeChanged
            ? 'dispatch'
            : 'rerun-affected-jobs',
      };
    }
    const context = { repo, input, run, jobs, names, expectedSha, deadline };
    this.log?.debug(
      `repair: verified changes; checking ${input.workflow} at ${expectedSha}`
    );
    const result = input.newRunId
      ? await this.monitorNew(context)
      : input.codeChanged
        ? await this.dispatch(context)
        : await this.rerun(context);
    return { ...location, ...result };
  }
  async monitorNew({ repo, input, expectedSha, names, deadline }) {
    const started = await this.runs.get(repo, input.newRunId);
    if (
      started.head_sha !== expectedSha ||
      !matchesWorkflow(started, input.workflow)
    ) {
      throw new CliError(
        'Caller-started run does not match the updated revision/workflow.',
        EXIT_CODES.VERIFICATION_FAILED
      );
    }
    return this.finish({
      repo,
      input,
      runId: input.newRunId,
      previousAttempt: 0,
      expectedSha,
      names: input.jobNames ?? names,
      deadline,
    });
  }

  async dispatch({ repo, input, expectedSha, names, deadline }) {
    const base = `${repoPath(repo)}/actions/workflows/${encodeURIComponent(input.workflow)}`;
    const previous = new Set(
      (
        await this.runs.list(repo, {
          workflow: input.workflow,
          event: 'workflow_dispatch',
        })
      ).map((entry) => entry.id)
    );
    const dispatched = await this.rest.request(`${base}/dispatches`, {
      method: 'POST',
      body: {
        ref: input.revision.ref,
        inputs: input.inputs ?? {},
        return_run_details: true,
      },
    });
    const located = await this.waitFor(
      async () => {
        if (dispatched?.workflow_run_id) {
          return this.runs.get(repo, dispatched.workflow_run_id);
        }
        const candidates = (
          await this.runs.list(repo, {
            workflow: input.workflow,
            event: 'workflow_dispatch',
          })
        ).filter(
          (entry) => !previous.has(entry.id) && entry.head_sha === expectedSha
        );
        // Ambiguous concurrent dispatches cannot be attributed to this repair.
        return candidates.length === 1 ? candidates[0] : null;
      },
      (candidate) => Boolean(candidate),
      deadline,
      input.interval
    );
    if (!located.accepted) {
      return {
        status: 'timeout',
        success: false,
        reason: 'dispatched-run-not-observed',
        sha: expectedSha,
      };
    }
    return this.finish({
      repo,
      input,
      runId: located.result.id,
      previousAttempt: 0,
      expectedSha,
      names: input.jobNames ?? names,
      deadline,
    });
  }

  async rerun({ repo, input, run, names, expectedSha, deadline }) {
    // Job reruns include normal dependents; never widen to every failed job.
    const attempts = [];
    let current = run;
    for (const name of names) {
      const waiting = await this.waitFor(
        () => this.runs.get(repo, input.runId),
        (run) => run.status === 'completed',
        deadline,
        input.interval
      );
      current = waiting.result;
      if (!waiting.accepted) {
        return {
          status: 'timeout',
          success: false,
          attempts,
          ...evidence(current),
        };
      }
      if (
        current.head_sha !== expectedSha ||
        !matchesWorkflow(current, input.workflow)
      ) {
        throw new JobsUnavailableError(
          repo,
          input.runId,
          'run-changed-before-rerun',
          current
        );
      }
      const latestJobs = await this.runs.jobs(repo, input.runId);
      const matching = latestJobs.filter((item) => item.name === name);
      if (matching.length !== 1) {
        throw new JobsUnavailableError(
          repo,
          input.runId,
          'ambiguous-selected-job',
          current
        );
      }
      const job = matching[0];
      if (job?.conclusion === 'success') {
        continue;
      }
      if (
        job.status !== 'completed' ||
        !['failure', 'timed_out', 'cancelled'].includes(job.conclusion) ||
        current.status !== 'completed' ||
        (attempts.length > 0 && this.now() >= deadline)
      ) {
        return {
          status: 'timeout',
          success: false,
          attempts,
          ...evidence(current, latestJobs),
        };
      }
      const before = await this.runs.get(repo, input.runId);
      if (
        before.status !== 'completed' ||
        before.run_attempt !== current.run_attempt ||
        before.head_sha !== expectedSha ||
        (job.discovery && job.discovery.runAttempt !== current.run_attempt)
      ) {
        throw new JobsUnavailableError(
          repo,
          input.runId,
          'run-changed-before-rerun',
          before
        );
      }
      await this.rest.request(
        `${repoPath(repo)}/actions/jobs/${job.id}/rerun`,
        { method: 'POST' }
      );
      const result = await this.finish({
        repo,
        input,
        runId: input.runId,
        previousAttempt: current.run_attempt,
        expectedSha,
        names: [name],
        deadline,
      });
      attempts.push(result);
      if (
        !['success', 'failure'].includes(result.status) ||
        !result.jobs.some(
          (item) => item.name === name && item.conclusion === 'success'
        )
      ) {
        return { ...result, attempts };
      }
      current = await this.runs.get(repo, input.runId);
    }
    return {
      ...(attempts.at(-1) ?? {
        status: 'skipped',
        success: false,
        reason: 'jobs-no-longer-failed',
      }),
      attempts,
    };
  }
}

export function createRepairVerifier(options = {}) {
  return new RepairVerifier(options);
}
