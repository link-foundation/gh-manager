/** Caller-driven configuration followed by optional relevant CI verification.
 * Usage: GH_TOKEN=... node examples/ensure-actions-variable.js owner/repo CUSTOM_NAME value [failed-run-id failed-job-id]
 * Values passed here are non-secret. Registry policy and account discovery belong to the caller.
 */
import {
  createRestClient,
  createVariableManager,
  createRepairVerifier,
} from '../src/index.js';

const [repo, name, value, run, job] = process.argv.slice(2);
if (!repo || !name || value === undefined) {
  throw new Error('Supply owner/repo, a variable name and a non-secret value.');
}
const rest = createRestClient({ token: process.env.GH_TOKEN });
const variables = createVariableManager({ rest, scope: { repo } });
const change = await variables.ensure(name, value);
console.log(JSON.stringify(change, null, 2));
if (!change.verified) {
  process.exitCode = 6;
} else if (run && job) {
  const result = await createRepairVerifier({ rest }).verify({
    repo,
    workflow: process.env.WORKFLOW_FILE ?? 'release.yml',
    runId: Number(run),
    jobIds: [Number(job)],
    changes: [change],
    timeout: 600000,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!['success', 'skipped'].includes(result.status)) {
    process.exitCode = 6;
  }
}
