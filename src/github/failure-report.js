/** Compact bulk results without discarding matches from partially readable runs. */
export function failureReport(findings, repos) {
  const report = {
    matches: [],
    unavailableLogs: [],
    errors: [],
    repositories: [],
  };
  const totals = new Map(
    repos.map((repo) => [
      repo.full_name,
      {
        repository: repo.full_name,
        matches: 0,
        unavailableLogs: 0,
        errors: 0,
      },
    ])
  );
  const missing = new Map();
  for (const finding of findings) {
    const counts = totals.get(finding.repository);
    if (finding.matches?.length) {
      report.matches.push({
        repository: finding.repository,
        workflow: finding.workflow,
        runId: finding.runId,
        runUrl: finding.runUrl,
        status: 'failure',
        matches: finding.matches,
      });
      counts.matches += finding.matches.length;
    }
    if (finding.error) {
      report.errors.push(finding);
      counts.errors++;
    }
    const unavailable =
      finding.unavailableLogs ??
      (finding.reason === 'logs-expired' ||
      finding.reason === 'logs-unavailable'
        ? [{ status: finding.reason }]
        : []);
    for (const entry of unavailable) {
      const key = `${finding.repository}:${entry.status}`;
      if (!missing.has(key)) {
        missing.set(key, {
          repository: finding.repository,
          reason: entry.status,
          count: 0,
        });
      }
      missing.get(key).count++;
      counts.unavailableLogs++;
    }
  }
  report.unavailableLogs = [...missing.values()];
  report.repositories = [...totals.values()];
  return report;
}
