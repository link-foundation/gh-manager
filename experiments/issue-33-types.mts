import {
  createRunManager,
  createRepairVerifier,
  JobsUnavailableError,
  type RestClient,
  type JobsUnavailable,
  type WorkflowJob,
} from '../src/index.js';

declare const rest: RestClient;
const runs = createRunManager({ rest, sleep: async (_ms: number) => {} });
const jobs: WorkflowJob[] = await runs.jobs('acme/one', 1, { attempt: 2 });
const individual: WorkflowJob = await runs.job('acme/one', jobs[0].id);
console.log(individual.run_attempt, individual.discovery?.checkRunId);
try {
  const logs = await runs.logs(1, { repo: 'acme/one' });
  for (const line of logs) {
    if ('status' in line && line.status === 'infrastructure-unavailable') {
      console.log(line.nextAction);
    } else if ('source' in line) {
      console.log(line.source, line.jobAttempt, line.sha);
    }
  }
} catch (error) {
  if (error instanceof JobsUnavailableError) {
    const unavailable: JobsUnavailable = error.evidence;
    console.log(unavailable.runUrl, unavailable.runAttempt);
  }
}
const result = await createRepairVerifier({ rest }).verify({
  repo: 'acme/one',
  workflow: 'release.yml',
  runId: 1,
  jobIds: [2],
  changes: [{ kind: 'setting', changed: true, verified: true }],
});
if (result.status === 'infrastructure-unavailable')
  console.log(result.nextAction);
console.log(result.jobs?.[0].runAttempt, result.jobs?.[0].discovery?.source);
