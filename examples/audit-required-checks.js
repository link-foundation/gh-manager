/**
 * Read-only required-check drift audit of one branch against a reviewed
 * scoped ruleset, using the public library API. Nothing is written.
 *
 *   node examples/audit-required-checks.js owner/repo .github/main-ruleset.json [branch]
 */
import { readFileSync } from 'node:fs';
import {
  createRestClient,
  createRulesetDrift,
  parseRepoSpec,
} from '../src/index.js';

const [spec, policyFile, branch] = process.argv.slice(2);
if (!spec || !policyFile) {
  throw new Error(
    'Usage: node examples/audit-required-checks.js owner/repo policy.json [branch]'
  );
}
const rest = createRestClient({
  token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
});
const drift = createRulesetDrift({ rest });
const plan = await drift.plan(
  parseRepoSpec(spec, {
    defaultOwner: () => {
      throw new Error('Pass the repository as owner/repo.');
    },
  }),
  JSON.parse(readFileSync(policyFile, 'utf8')),
  { branch }
);
console.log(
  JSON.stringify(
    {
      action: plan.action,
      ruleset: plan.ruleset,
      checks: plan.checks,
      findings: plan.findings,
      warnings: plan.warnings,
      changes: plan.changes,
    },
    null,
    2
  )
);
process.exitCode = plan.compliant ? 0 : 1;
