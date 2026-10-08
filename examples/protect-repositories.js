import {
  createProtectionManager,
  createRestClient,
  resolveToken,
} from '../src/index.js';

// A read-only preview; remove dryRun only when ready to apply the plan.
const { token } = resolveToken();
const manager = createProtectionManager({ rest: createRestClient({ token }) });
const plan = await manager.protect(
  { org: 'link-foundation' },
  { dryRun: true }
);
for (const entry of plan.repositories) {
  console.log(
    `${entry.repository}: ${entry.action}${entry.reason ? ` (${entry.reason})` : ''}`
  );
}
