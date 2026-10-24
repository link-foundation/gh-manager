# Issue 24 work plan

Objective: implement issues 22 and 23 completely in PR 25, retain separate closing references for all three issues, and verify final-head CI. No merges to main.

- [x] Read parent, native sub-issues, every issue comment, and PR conversation/inline comments/reviews (none yet).
- [x] Inspect contributing/release instructions, architecture, and recent merged PRs.
- [x] Research official API contracts, defaults, browser-only settings, and existing components.
- [x] Record every requirement, alternatives, chosen implementation, and verification in docs/issue-24.md.
- [x] Add failing regression tests before implementing missing security and Pages features.
- [x] Extend shared feature registry/API/browser gateway and status defaults across CLI/library/types/docs.
- [x] Add advanced CodeQL conflict detection before writes.
- [x] Implement Pages status/source create/update, branch paths, confirmation, dry-run, JSON, verified reads.
- [x] Add fixture tests before doctor implementation for every static and log rule.
- [x] Implement single/user/org scans, evidence, read-only reports, confirmed fixes, verification, causal reruns and opt-out, nonzero unresolved findings, bulk error isolation.
- [x] Investigate existing failing CI: list timestamp/SHA, preserve logs in ci-logs, identify exact failures, fix, verify.
- [x] Investigate first-publish/trusted-publisher note and document/resolve any authentication blocker honestly.
- [x] Add minor changeset, examples, user documentation and requirement evidence.
- [x] Run focused tests, full suites, lint/format/duplication, syntax/types/line limits/secrets and other applicable local CI checks sequentially within memory budget (Node 815, Bun 815, Deno 752 plus 8 steps; zero failures; both audits clean).
- [ ] Commit useful atomic steps only on issue-24-8d7c83698303 after local checks; preserve history.
- [ ] Fetch/merge latest main, push only prepared branch, update PR title/body and closing keywords.
- [ ] Review gh pr diff for regressions and scope; verify latest-head CI, download/analyze failures, repair until passing.
- [ ] Re-read latest feedback, verify clean status, mark PR ready; report PR URL and any genuinely blocked criteria.

Constraints: save large logs; read files over 1500 lines in chunks; keep probes/scripts in experiments/examples; finite stress inputs; run memory-heavy commands sequentially; no self-imposed command timeouts; wait for all background commands.

External blocker: npm first publication/trusted-publisher attachment remains unfinished: npm package E404; npm whoami ENEEDAUTH; no authenticated browser profile. Evidence and next operation in docs/issue-24.md.
