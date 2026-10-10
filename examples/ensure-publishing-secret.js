import {
  createRestClient,
  createSecretManager,
  createSecretHealth,
  resolveToken,
} from '../src/index.js';

// The caller owns issuance and revocation. GitHub logs establish health;
// gh-manager only stores the caller's custom name and in-memory value.
export async function ensurePublishingSecret({
  name,
  organization,
  repositories,
  failurePatterns = [],
  acquire,
  revokePrevious,
}) {
  const { token } = resolveToken();
  const options = {
    rest: createRestClient({ token }),
  };
  const scope = { org: organization };
  const health = createSecretHealth(options);
  const before = await health.health(name, {
    scope,
    repos: repositories,
    failurePatterns,
  });
  const manager = createSecretManager({
    ...options,
    scope: { org: organization },
  });
  const storage = await manager.ensure(name, {
    repos: repositories,
    health: before,
    acquire,
  });
  const after =
    storage.changed || before.status === 'unknown'
      ? await health.test(name, { scope, repos: repositories, failurePatterns })
      : before;
  // Revoke only after the replacement has passed the workflow that uses it.
  if (storage.valueChanged && after.status === 'ok' && revokePrevious) {
    await revokePrevious();
  }
  return { storage, health: after };
}
