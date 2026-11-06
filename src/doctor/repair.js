import { repositoryTarget } from '../github/discovery.js';
import { repoPath } from '../github/rest.js';
import { findSecurityFeature } from '../security/features.js';
import { pollUntil } from '../verification.js';
import { JobsUnavailableError, validJob } from '../github/jobs.js';

async function rerunCausalJobs(entry, repo, id, { runs, rest }) {
  const evidence = entry.findings
    .filter(
      (f) => f.source !== 'branch-rules' && f.resolved && f.result?.changed
    )
    .flatMap((f) =>
      f.evidence.filter((e) => e.kind === 'log' && e.runId === id)
    );
  const names = new Set();
  let previousAttempt = 0;
  for (const selected of evidence) {
    if (names.has(selected.job)) {
      continue;
    }
    names.add(selected.job);
    const waited = await pollUntil({
      read: () => runs.get(repo, id),
      accept: (run) =>
        run.status === 'completed' && run.run_attempt > previousAttempt,
      timeout: 600000,
      interval: 2000,
    });
    const run = waited.value;
    if (!waited.accepted) {
      throw new JobsUnavailableError(repo, id, 'active-attempt-timeout', run);
    }
    const jobs = await runs.jobs(repo, id);
    const matching = jobs.filter((job) => job.name === selected.job);
    if (matching.length !== 1) {
      throw new JobsUnavailableError(repo, id, 'ambiguous-causal-job', run);
    }
    const job = matching[0];
    if (selected.sha && selected.sha !== run.head_sha) {
      throw new JobsUnavailableError(repo, id, 'stale-causal-log', run);
    }
    if (selected.jobId !== job.id) {
      const old = await runs.job(repo, selected.jobId);
      if (!validJob(old, repo, run, selected.jobId) || old.name !== job.name) {
        throw new JobsUnavailableError(
          repo,
          id,
          'causal-job-provenance-mismatch',
          run
        );
      }
    }
    if (job.conclusion === 'success') {
      continue;
    }
    if (
      job.status !== 'completed' ||
      !['failure', 'timed_out', 'cancelled'].includes(job.conclusion)
    ) {
      throw new JobsUnavailableError(
        repo,
        id,
        'causal-job-no-longer-failed',
        run
      );
    }
    await rest.request(`${repoPath(repo)}/actions/jobs/${job.id}/rerun`, {
      method: 'POST',
    });
    previousAttempt = run.run_attempt;
    entry.reruns.push({
      runId: id,
      jobId: job.id,
      job: job.name,
      runAttempt: run.run_attempt,
      status: 'requested',
      runUrl: run.html_url,
    });
  }
}

export async function repairRepository(
  entry,
  { rerun, gateway, pages, runs, rest }
) {
  const repo = repositoryTarget(entry.repository);
  const settings = gateway(repo);
  for (const finding of entry.findings) {
    // Branch-rules findings are applied by the ruleset drift repair.
    if (!finding.fixable || finding.source === 'branch-rules') {
      continue;
    }
    try {
      // The gateways re-read current state and verify every accepted write.
      const result =
        finding.setting === 'pages'
          ? await pages.setSource(repo, { build_type: 'workflow' })
          : await settings.setFeature({
              feature: findSecurityFeature(finding.setting),
              enabled: finding.required === 'enabled',
            });
      finding.result = result;
      finding.resolved = true;
    } catch (error) {
      finding.error = error.message;
    }
  }
  if (!rerun || entry.errors.length) {
    return;
  }
  const runIds = new Set(
    entry.findings
      .filter(
        (f) => f.source !== 'branch-rules' && f.resolved && f.result?.changed
      )
      .flatMap((f) =>
        f.evidence.filter((e) => e.kind === 'log').map((e) => e.runId)
      )
  );
  for (const id of runIds) {
    if (
      entry.findings.some(
        (f) => !f.resolved && f.evidence.some((e) => e.runId === id)
      )
    ) {
      continue;
    }
    try {
      const run = await runs.get(repo, id);
      const metadata = await rest.request(repoPath(repo));
      if (
        run.status !== 'completed' ||
        run.conclusion !== 'failure' ||
        run.head_branch !== metadata.default_branch
      ) {
        entry.reruns.push({
          runId: id,
          status: 'skipped',
          reason: 'run-no-longer-failed-on-default-branch',
        });
        continue;
      }
      await rerunCausalJobs(entry, repo, id, { runs, rest });
    } catch (error) {
      entry.errors.push({ runId: id, ...error.evidence, error: error.message });
    }
  }
}
