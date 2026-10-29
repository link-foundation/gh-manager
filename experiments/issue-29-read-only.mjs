/** Live read-only API probe. Prints counts and precedence, never variable values. */
import assert from 'node:assert/strict';
import {
  createRestClient,
  createVariableManager,
  resolveToken,
} from '../src/index.js';

const repo = process.argv[2] ?? 'link-foundation/gh-manager';
const { token } = resolveToken();
const manager = createVariableManager({
  rest: createRestClient({ token }),
  scope: { repo },
});
const inventory = await manager.list();
const name = 'GH_MANAGER_ISSUE_29_READ_ONLY_PROBE';
const absent = await manager.get(name);
assert.equal(absent, null);
const state = await manager.effective(name);
assert.equal(state.verified, true);
assert.equal(state.value, null);
console.log(
  JSON.stringify({
    repo,
    count: inventory.length,
    absent: true,
    effectiveVerified: state.verified,
    candidates: state.candidates.length,
  })
);
