import { CliError } from '../exit-codes.js';
import { repoPath } from './rest.js';
import { repoSlug } from './repo.js';
import { pages } from './discovery.js';
import { delay } from '../verification.js';

const transient = (error) => error.status >= 500 && error.status <= 599;

/** A missing inventory is infrastructure evidence, never an empty green run. */
export class JobsUnavailableError extends CliError {
  constructor(repo, id, reason, run) {
    const runUrl = `https://github.com/${repoSlug(repo)}/actions/runs/${id}`;
    const nextAction = `Retry job discovery for ${runUrl}; if GitHub remains unavailable, inspect this run's current attempt and individual job URLs before retrying a selected job.`;
    super(`Actions jobs unavailable (${reason}). ${nextAction}`);
    this.name = 'JobsUnavailableError';
    this.evidence = {
      status: 'infrastructure-unavailable',
      reason,
      repository: repoSlug(repo),
      runId: id,
      runUrl,
      runAttempt: run?.run_attempt ?? null,
      sha: run?.head_sha ?? null,
      nextAction,
    };
  }
}

/** Retry only reads: an ambiguous mutation must never be sent twice. */
export async function retryJobRead(read, { sleep = delay, log } = {}) {
  for (let retry = 0; ; retry++) {
    try {
      return await read();
    } catch (error) {
      if (!transient(error) || retry === 2) {
        throw error;
      }
      log?.debug(
        `Actions job read: HTTP ${error.status}; retry ${retry + 1}/2`
      );
      await sleep(250 * 2 ** retry);
    }
  }
}

function jobIdFromUrl(url, repo, runId) {
  const match = String(url).match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)\/?$/
  );
  return match &&
    `${match[1]}/${match[2]}`.toLowerCase() === repoSlug(repo).toLowerCase() &&
    Number(match[3]) === runId &&
    Number.isSafeInteger(Number(match[4]))
    ? Number(match[4])
    : null;
}

export function validJob(job, repo, run, id) {
  return (
    job?.id === id &&
    job.run_id === run.id &&
    jobIdFromUrl(job.html_url, repo, run.id) === id &&
    job.run_url?.toLowerCase() ===
      `https://api.github.com${repoPath(repo)}/actions/runs/${run.id}`.toLowerCase() &&
    job.head_sha === run.head_sha &&
    Number.isSafeInteger(job.run_attempt) &&
    job.run_attempt >= 1 &&
    job.run_attempt <= run.run_attempt &&
    typeof job.name === 'string' &&
    Boolean(job.name) &&
    [
      'queued',
      'in_progress',
      'completed',
      'waiting',
      'pending',
      'requested',
    ].includes(job.status) &&
    (job.status !== 'completed' || typeof job.conclusion === 'string')
  );
}

async function sourceChecks(rest, base, sha) {
  let total;
  let received = 0;
  const reader = {
    request: async (path) => {
      const body = await rest.request(path);
      if (
        !Number.isSafeInteger(body?.total_count) ||
        body.total_count < 0 ||
        (total !== undefined && total !== body.total_count)
      ) {
        throw new Error('incomplete-check-inventory');
      }
      total = body.total_count;
      if (!Array.isArray(body.check_runs)) {
        throw new Error('incomplete-check-inventory');
      }
      received += body.check_runs.length;
      if (received > total) {
        throw new Error('incomplete-check-inventory');
      }
      return body;
    },
  };
  const checks = await pages(
    reader,
    `${base}/commits/${sha}/check-runs`,
    'check_runs',
    { query: { filter: 'all' } }
  );
  if (
    checks.length !== total ||
    new Set(checks.map((c) => c.id)).size !== checks.length
  ) {
    throw new Error('incomplete-check-inventory');
  }
  return checks;
}

function validRun(run, repo, id, attempt) {
  return (
    run?.id === id &&
    run.html_url?.toLowerCase() ===
      `https://github.com/${repoSlug(repo)}/actions/runs/${id}`.toLowerCase() &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(run.head_sha ?? '') &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt >= 1 &&
    Number.isSafeInteger(run.check_suite_id) &&
    run.check_suite_id > 0 &&
    [
      'queued',
      'in_progress',
      'completed',
      'waiting',
      'pending',
      'requested',
    ].includes(run.status) &&
    (!attempt || attempt <= run.run_attempt)
  );
}

function agreesWithCheck(job, check) {
  return (
    check.name === job.name &&
    check.status === job.status &&
    check.conclusion === job.conclusion
  );
}

async function collectJobs({ checks, rest, repo, run, attempt, read, fail }) {
  const jobs = new Map();
  for (const check of checks) {
    const jobId = jobIdFromUrl(check.details_url, repo, run.id);
    const belongs = check.check_suite?.id === run.check_suite_id;
    if (!belongs && !jobId) {
      continue;
    }
    if (!belongs || !jobId || check.head_sha !== run.head_sha) {
      throw fail('check-run-provenance-mismatch');
    }
    const job = await read(() =>
      rest.request(`${repoPath(repo)}/actions/jobs/${jobId}`)
    );
    if (!validJob(job, repo, run, jobId) || !agreesWithCheck(job, check)) {
      throw fail('individual-job-provenance-mismatch');
    }
    if (attempt && job.run_attempt !== attempt) {
      continue;
    }
    const previous = jobs.get(job.name);
    if (previous?.run_attempt === job.run_attempt && previous.id !== job.id) {
      throw fail('ambiguous-job-identity');
    }
    if (!previous || previous.run_attempt < job.run_attempt) {
      jobs.set(job.name, {
        ...job,
        discovery: {
          source: 'check-runs',
          checkRunId: check.id,
          runAttempt: run.run_attempt,
        },
      });
    }
  }
  return [...jobs.values()];
}

async function recoverJobs(rest, repo, id, attempt, read) {
  let run;
  const fail = (reason) => new JobsUnavailableError(repo, id, reason, run);
  try {
    const base = repoPath(repo);
    run = await read(() => rest.request(`${base}/actions/runs/${id}`));
    if (!validRun(run, repo, id, attempt)) {
      throw fail('incomplete-run-evidence');
    }
    const checks = await read(() => sourceChecks(rest, base, run.head_sha));
    const result = await collectJobs({
      checks,
      rest,
      repo,
      run,
      attempt,
      read,
      fail,
    });
    if (
      !result.length ||
      !result.some((j) => j.run_attempt === (attempt ?? run.run_attempt))
    ) {
      throw fail('incomplete-job-evidence');
    }
    if (
      run.status === 'completed' &&
      result.some((j) => j.status !== 'completed')
    ) {
      throw fail('incomplete-job-status');
    }
    const after = await read(() => rest.request(`${base}/actions/runs/${id}`));
    if (
      [
        'id',
        'head_sha',
        'run_attempt',
        'status',
        'conclusion',
        'check_suite_id',
      ].some((key) => after?.[key] !== run[key])
    ) {
      throw fail('run-changed-during-discovery');
    }
    return result;
  } catch (error) {
    if (error instanceof JobsUnavailableError) {
      throw error;
    }
    throw fail('fallback-evidence-unavailable');
  }
}

export async function discoverJobs({ rest, repo, id, attempt, sleep, log }) {
  const read = (operation) => retryJobRead(operation, { sleep, log });
  const path = `${repoPath(repo)}/actions/runs/${id}${attempt ? `/attempts/${attempt}` : ''}/jobs`;
  try {
    return await read(() =>
      pages(rest, path, 'jobs', { query: attempt ? {} : { filter: 'latest' } })
    );
  } catch (error) {
    if (!transient(error)) {
      throw error;
    }
    log?.debug(
      `Actions job list unavailable for run ${id}; validating source check-runs`
    );
    return recoverJobs(rest, repo, id, attempt, read);
  }
}
