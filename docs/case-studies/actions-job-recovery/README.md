# Actions job discovery during a GitHub outage

[Issue 33](https://github.com/link-foundation/gh-manager/issues/33) reports job-list
HTTP 502 responses for
[run 42104467330](https://github.com/link-foundation/links-notation/actions/runs/42104467330),
including attempt-scoped listing. Version 1.5.0 propagated the error, preventing
targeted repair even though source checks and individual jobs were readable.
Partial reruns also replaced job IDs, making previously selected IDs stale.

## Reproduction and regression evidence

```sh
node --test --test-timeout=30000 tests/job-recovery.test.js tests/job-recovery-evidence.test.js tests/doctor-job-recovery.test.js
```

The initial recovery fixture suite was run against the original `runs.js` from
`cab12f0`: 15 of 16 cases failed, including the working check-run/individual-job
fallback. The same cases pass with the fix. Additional regressions verify
sequential attempts, pagination, concurrent attempt changes and mutation scope.

| Requirement                            | Verification                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Bounded transient read retries         | Exact three-read ceiling, retry delays, transient success and authorization errors                                 |
| Exact run, repository, SHA and attempt | Same-SHA unrelated runs, URL mismatches, individual response mismatches, missing metadata and ambiguous identities |
| Complete inventory                     | Paginated source checks, missing checks, inconsistent totals and discarded partial job-list pages                  |
| Refresh stale selected IDs             | Java/Kotlin sequential retries use fresh IDs, with an unrelated failure left untouched                             |
| Wait for an active attempt             | Initial active run completes before selection; zero waiting budget returns timeout without writing                 |
| Preserve log provenance                | Current individual log carries job ID, attempt and SHA; older successful logs are not substituted                  |
| Refuse unreliable recovery             | Structured infrastructure status, run URL and next action in API, logs and repair CLI results                      |
| Keep writes narrow                     | Only selected job rerun endpoints; failed writes are never retried or widened; concurrent changes prevent writes   |

## Read-only check against the reported run

On 2026-11-06, the reusable example recovered 101 jobs from the reported run
after three job-list HTTP 502 responses. All returned jobs had source
`check-runs`, attempt 6 and SHA `f7392958aff149e18525947d305594dde31ad145`.
The two remaining failures were `release_audit / audit` (job 127629110434) and
`release / php / publishToPackagist` (job 127628652907). They remained visible;
the example performed no mutations.

```sh
GH_TOKEN="$(gh auth token)" node examples/discover-actions-jobs.js link-foundation/links-notation 42104467330
```

Recovery uses GitHub's
[source check-runs endpoint](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
with `filter=all`, verifies the run's check suite and canonical job URL, then
validates each candidate against its individual Actions job response. A stable
run snapshot is required before accepting the inventory. This costs additional
read requests during an outage; ordinary job listing retains its fast path.

Only individual job logs are used. Attempt ZIP logs are not substituted, so
there is no archive-to-job inference or stale-archive success path.
