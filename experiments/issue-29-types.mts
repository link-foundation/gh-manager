/** Compile-only consumer: npx --package typescript tsc --noEmit --strict --module nodenext experiments/issue-29-types.mts */
import {
  createRestClient,
  createVariableManager,
  variables,
  createRepairVerifier,
  type RepairVerificationResult,
} from '../src/index.js';

export async function verifiedRepair() {
  const rest = createRestClient({ token: null });
  const manager = createVariableManager({
    rest,
    scope: { repo: 'owner/project' },
  });
  const change = await manager.ensure('CALLER_NAME', 'non-secret');
  const result: RepairVerificationResult = await createRepairVerifier({
    rest,
  }).verify({
    repo: 'owner/project',
    workflow: 'publish.yml',
    runId: 1,
    jobIds: [2],
    changes: [change],
    requiredPermissions: [
      { job: 'publish', permission: 'id-token', level: 'write' },
    ],
  });
  await variables({ rest, scope: { org: 'owner' } }).ensure('CALLER_NAME', '', {
    repos: ['project'],
  });
  await manager.effective('CALLER_NAME', {
    repo: 'owner/project',
    environment: 'production',
  });
  return result;
}
