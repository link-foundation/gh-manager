# Issue 33 implementation and verification plan

Objective: implement every requirement of issue 33 in PR 34. The issue has no
comments or required sub-issues; all three PR feedback streams were empty at
initial inspection.

- [x] Read issue, comments, sub-issues, PR feedback, contributing guidance and recent related PRs.
- [x] Reproduce job-list 502 and incomplete discovery with focused fixture regressions.
- [x] Bound transient read retries; recover jobs from paginated source check-runs
      with exact repository/run URL, individual response, SHA, attempt and status validation.
- [x] Preserve provenance and refuse incomplete/ambiguous discovery with an
      infrastructure-unavailable result containing run URL and a next action.
- [x] Refresh selected causal job IDs between sequential attempts and wait for
      active attempts; never widen selected retries because discovery failed.
- [x] Retain provenance on individual log evidence; never substitute stale
      attempt ZIP logs for current job logs (no ZIP fallback is planned).
- [x] Cover stale IDs, unrelated same-SHA runs, partial/malformed evidence,
      attempt polling and mutation scope with small automated regressions.
- [x] Update declarations, documentation, reusable example and release changeset.
- [x] Run focused checks; commit atomic changes and push only the prepared branch.
- [x] Include current main, review full PR diff, refresh all feedback streams,
      update PR title/body with reproduction and requirement/test evidence.

Final audit (results maintained in [PR 34](https://github.com/link-foundation/gh-manager/pull/34)):
verify CI timestamps/SHA for the final commit, save and inspect any failed logs,
ensure a clean worktree, and mark PR 34 ready without merging. CI evidence and
readiness are recorded there to avoid a documentation-only commit superseding
the fully tested code commit.

Assumptions: job-list results retain their public array shape. When recovery
cannot establish a complete inventory, a typed unavailable error carries the
structured infrastructure status; repair verification and log discovery expose
that status as evidence instead of reporting success. Partial reruns may carry
forward jobs from earlier attempts, so attempt provenance must remain explicit.

Local evidence: 98 related tests passed; the additional doctor freshness cases
bring the focused recovery/doctor group to 53 passing tests. Strict public type
checking and `npm run check` passed. The initial CI run for `9d473eb` failed only
the duplication gate: `ci-logs/checks-42167842758.log`, lines 1240–1242, identified
the shared repair input fixture. The follow-up extracts the shared fixture and
manager setup, and the duplication check now passes without new clones.

The next CI run found the public export inventory missing `JobsUnavailableError`:
`ci-logs/checks-node-127730622260.log`, lines 1585–1589, and
`ci-logs/checks-deno-127730622097.log`, lines 1664–1669. All other Ubuntu Node
tests passed (931). Update the existing inventory test to include the new
documented export, then rerun that focused test before pushing.
