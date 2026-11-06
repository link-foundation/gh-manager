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
- [ ] Run focused checks; commit atomic changes and push only the prepared branch.
- [ ] Merge current main, review full PR diff, refresh all feedback streams,
      update PR title/body with reproduction and requirement/test evidence.
- [ ] Verify CI timestamps/SHA for final commit, save and inspect any failed logs,
      ensure clean worktree, and mark PR 34 ready without merging.

Assumptions: job-list results retain their public array shape. When recovery
cannot establish a complete inventory, a typed unavailable error carries the
structured infrastructure status; repair verification and log discovery expose
that status as evidence instead of reporting success. Partial reruns may carry
forward jobs from earlier attempts, so attempt provenance must remain explicit.
