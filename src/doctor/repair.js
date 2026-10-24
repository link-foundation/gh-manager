import { repositoryTarget } from '../github/discovery.js';
import { repoPath } from '../github/rest.js';
import { findSecurityFeature } from '../security/features.js';

export async function repairRepository(
  entry,
  { rerun, gateway, pages, runs, rest }
) {
  const repo = repositoryTarget(entry.repository);
  const settings = gateway(repo);
  for (const finding of entry.findings) {
    if (!finding.fixable) {
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
      .filter((f) => f.resolved && f.result.changed)
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
      await rest.request(
        `${repoPath(repo)}/actions/runs/${id}/rerun-failed-jobs`,
        { method: 'POST' }
      );
      entry.reruns.push({
        runId: id,
        status: 'requested',
        runUrl: run.html_url,
      });
    } catch (error) {
      entry.errors.push({ runId: id, error: error.message });
    }
  }
}
