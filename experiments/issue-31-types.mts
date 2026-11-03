/** Compile-only consumer: npx --package typescript tsc --noEmit --strict --module nodenext experiments/issue-31-types.mts */
import {
  createDoctor,
  createRestClient,
  createRulesetDrift,
  classifyCheck,
  compareChecks,
  desiredChecks,
  effectiveChecks,
  workflowProducers,
  type ScopedRulesetDocument,
  type RulesetDriftResult,
} from '../src/index.js';

const policy: ScopedRulesetDocument = {
  name: 'main checks',
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  bypass_actors: [],
  rules: [{ type: 'deletion' }],
};

export async function audit(): Promise<RulesetDriftResult> {
  const rest = createRestClient({ token: null });
  const drift = createRulesetDrift({ rest, verificationTimeout: 0 });
  const plan = await drift.plan({ owner: 'o', name: 'r' }, policy, {
    branch: 'main',
  });
  const missing: string[] = plan.checks?.missing ?? [];
  void missing;
  const report = await createDoctor({ rest, drift }).scan(
    { repo: 'o/r' },
    { policy, branch: 'main', rulesetId: 1 }
  );
  void report.repositories[0].branchRules?.checks;
  const compared = compareChecks(
    desiredChecks(policy),
    effectiveChecks([], null)
  );
  void compared.wrongIntegration[0]?.current[0]?.source.type;
  const { producers } = workflowProducers([{ path: 'a.yml', content: '' }]);
  void classifyCheck('Cpp', producers).status;
  return drift.apply(plan, policy, { confirm: () => true });
}
