# Case Study: Required-check drift in a main-only ruleset

**Issue:** [link-foundation/gh-manager#31](https://github.com/link-foundation/gh-manager/issues/31)
**Downstream:** [link-foundation/links-notation#192](https://github.com/link-foundation/links-notation/issues/192)

## Problem statement

`link-foundation/links-notation` keeps a reviewed ruleset in
`.github/main-ruleset.json` (see [data/main-ruleset.json](data/main-ruleset.json)).
It covers only `refs/heads/main` and requires ten GitHub Actions gates, all
bound to integration `15368`:
`JavaScript, Rust, Python, Java, Go, CSharp, PHP, Cpp, Swift, Kotlin`.

The live repository ruleset `24860631`
([data/ruleset-24860631.json](data/ruleset-24860631.json)) and the effective
rules on `main` ([data/effective-rules-main.json](data/effective-rules-main.json))
require only seven of them. **Cpp, Swift and Kotlin are not enforced**, even
though all ten jobs exist in
[data/links-notation-ci-js.yml](data/links-notation-ci-js.yml) and pass on
`5ce8287c880239ae4202c9071daa4429342b4a09`
([data/check-runs-5ce8287.json](data/check-runs-5ce8287.json)).

gh-manager 1.4.0 could not report or repair this:

- `doctor` only derived security and Pages requirements from workflows and
  failed logs; it never compared a desired branch policy with effective rules.
- `protect --from` accepted only all-branch policies and exited `2` on the
  `conditions.ref_name` and `bypass_actors` fields. Removing the conditions
  would have imposed main's pull-request and check policy on every branch.

## Root cause

The protection schema assumed one shape: a baseline ruleset covering `~ALL`
branches with no bypass actors. A reviewed ruleset scoped to some branches
had no model in the tool, so there was nothing to compare against, and no
repair path that could keep the existing ruleset's scope.

## Solution

`src/protection/scoped.js` models scoped policies as pure functions:
coverage, desired versus effective checks (compared by context **and** app
identity), and a repair that only strengthens a ruleset. `src/protection/drift.js`
gathers the evidence and plans or applies the repair:

| Evidence                                      | Endpoint                                                        |
| --------------------------------------------- | --------------------------------------------------------------- |
| Effective rules (repository and organization) | `GET /repos/{o}/{r}/rules/branches/{branch}`                    |
| Rulesets, including inherited ones            | `GET /repos/{o}/{r}/rulesets?includes_parents=true` and `/{id}` |
| Classic protection                            | `GET /repos/{o}/{r}/branches/{branch}/protection` (404 = none)  |
| Workflows at the branch head                  | git tree and blobs of the head commit                           |
| Check-run apps at the branch head             | `GET /repos/{o}/{r}/commits/{sha}/check-runs`                   |

Findings use `source: "branch-rules"` and the doctor finding shape
(`setting`, `current`, `required`, `fixable`, `evidence`):

- `required-status-check`: a context that is missing or bound to another app;
- `required-check-workflow`: no pull-request workflow produces the name,
  or only a push-only workflow does (matrix-only names are warned);
- `required-check-app`: check runs of that name come from a different app;
- `ruleset-rule`, `ruleset-enforcement`: weaker or inactive rules, such as a
  lost strict (same-commit) setting or an `evaluate` ruleset;
- `ruleset-scope`, `ruleset-target`: scope drift or an ambiguous target;
- `protection-evidence`, `administration-permission`: unreadable evidence or
  missing write permission, with the browser/API fallback.

The repair keeps the target's conditions, bypass actors, stronger parameters,
extra rules and app bindings. It never removes checks. Checks enforced by an
organization ruleset or classic protection are reported, never edited.

The dry-run plan is fingerprinted from the ruleset's `updated_at` and the
before/after bodies. `--plan` refuses a stale plan, and the write re-reads the
ruleset first to catch concurrent edits. After writing, it polls both the
saved ruleset and the effective branch rules. Ruleset repairs never rerun CI:
the downstream run's failures were registry credentials and package delivery,
which stricter enforcement cannot fix.

## Reproduction against the captured live shape

```bash
node experiments/issue-31-drift-plan.mjs          # read-only plan
node experiments/issue-31-drift-plan.mjs --apply  # apply, then re-plan
node experiments/issue-31-doctor-cli.mjs          # doctor --from report
```

The plan reports `missing: ["Cpp", "Swift", "Kotlin"]` and `update` of
ruleset `24860631`. Its changes are
`require check Cpp/Swift/Kotlin (integration 15368)` and the rename to the
policy's name. Conditions stay `include: ["refs/heads/main"]` and bypass
actors stay `[]`. After applying, the effective rules contain the ten checks
and a second plan reports `no change`.

`tests/protection-drift.test.js` and `tests/doctor-branch-rules.test.js`
cover this shape and fixtures for:

- inherited organization constraints and classic protection;
- stale plans and concurrent changes;
- missing Administration permission and 403 responses;
- hidden bypass actors and unreadable effective rules;
- wrong check-app identity;
- older and newer workflow revisions;
- push-only and matrix producers.

## Live repository

No live branch protection was changed while solving this issue. Applying the
repair to `link-foundation/links-notation` requires its administrator to run:

```bash
gh-manager protect link-foundation/links-notation \
  --from .github/main-ruleset.json --dry-run --json > plan.json
gh-manager protect link-foundation/links-notation \
  --from .github/main-ruleset.json --plan plan.json
```
