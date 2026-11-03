// Plan (read-only) the issue #31 repair against the captured live shape.
import { createRulesetDrift } from '../src/protection/drift.js';
import { driftApi, desiredPolicy } from '../tests/fixtures/drift-api.js';

const api = driftApi();
const drift = createRulesetDrift({ rest: api.rest, verificationTimeout: 0 });
const plan = await drift.plan(
  { owner: 'acme', name: 'links-notation' },
  desiredPolicy()
);
console.log(JSON.stringify(plan, null, 2));
console.log('writes', api.writes().length);
if (process.argv.includes('--apply')) {
  const result = await drift.apply(plan, desiredPolicy(), {
    confirm: async () => true,
  });
  console.log(
    JSON.stringify(result.readBack),
    result.action,
    api.writes().length
  );
  const again = await drift.plan(
    { owner: 'acme', name: 'links-notation' },
    desiredPolicy()
  );
  console.log('second', again.action, again.findings, api.writes().length);
}
