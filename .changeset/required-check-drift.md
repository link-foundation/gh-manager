---
'@link-foundation/gh-manager': minor
---

Audit and repair required-check drift against a reviewed scoped ruleset. `protect --from` accepts rulesets with `conditions.ref_name`. It compares them with the effective repository, organization and classic rules on the selected branch, then validates check names against the workflows and check-run apps at the branch head. The fingerprinted dry-run plan updates the existing ruleset in place, keeps its scope, bypass actors and stronger settings, and refuses stale or concurrently changed plans. After writing, it reads back both the ruleset and the effective rules. `doctor --from` reports the same `branch-rules` findings and repairs them with `--fix`, without rerunning workflows. Adds `--branch`, `--ruleset`, `--plan` and the `createRulesetDrift` library API.
