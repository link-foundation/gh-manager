import {
  createRunManager,
  createSecretHealth,
  createSecretManager,
  type RestClient,
  type RunFailureReport,
  type SecretHealthResult,
} from '../src/index.js';

// Compile with: npx -p typescript tsc --noEmit --strict --module nodenext --lib es2022,dom experiments/issue-20-types.mts
export async function inspectSecrets(rest: RestClient) {
  const scope = { org: 'acme' };
  const result: SecretHealthResult = await createSecretHealth({ rest }).health(
    'CUSTOM_TOKEN',
    { scope, rotateBeforeMs: 86400000 }
  );
  const report: RunFailureReport = await createRunManager({
    rest,
  }).failureReport({ org: 'acme' });
  await createSecretManager({
    rest,
    scope,
    recoverOrganizationAuth: async () => rest,
  }).ensure('CUSTOM_TOKEN', {
    health: result,
    dryRun: true,
  });
  return { expiresAt: result.expiresAt, scope: result.expiry.scope, report };
}
