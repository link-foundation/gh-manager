# Repository settings and CI diagnosis: issues 24, 22, and 23

This is the requirement inventory and implementation rationale for
[PR 25](https://github.com/link-foundation/gh-manager/pull/25).
The parent issue requires both sub-issues in one PR and a separate positive
closing reference for each issue. All issue comments and all three PR feedback
streams were read; none existed when implementation began.

## Research and component choices

The existing REST client already handles authentication, pagination, redirects,
rate limits, and error classification. Reusing it avoids another authentication
stack. [Octokit](https://octokit.github.io/rest.js/) is an alternative maintained
client, but would duplicate those capabilities. Existing repository discovery,
workflow-log scanning, security gateways, Browser Commander, and Playwright cover
the integration points. No new runtime dependency is needed.

The existing [yaml](https://eemeli.org/yaml/) package provides parsed steps and
source ranges. Parsing YAML avoids acting on commented-out action names; plain
regular expressions across the whole file would produce false positives.
[Dependency Review's configuration](https://github.com/actions/dependency-review-action/blob/main/README.md)
defaults vulnerability checks to true, so alerts are required unless the step
explicitly disables that check.

The [Pages REST contract](https://docs.github.com/en/rest/pages/pages)
uses POST for creation and PUT for updates. Its source has `workflow` or
`legacy` build types; legacy paths are restricted to `/` and `/docs`.
The [code-scanning REST contract](https://docs.github.com/en/rest/code-scanning/code-scanning)
uses `configured` and `not-configured` and may accept a write asynchronously.
Every mutation therefore polls a fresh read, with a finite verification window.
[GitHub's setup guidance](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning)
explains the advanced/default setup conflict; enabling default setup must not
silently supersede a repository's advanced workflow.

[Repository REST settings](https://docs.github.com/en/rest/repos/repos)
expose the secret-scanning analysis properties and private reporting endpoint.
The graph and remaining page-only controls use the existing browser gateway.
Known headings have stable CLI verbs; additional rows with their own heading
and container are discovered and can be addressed by exact heading. An ambiguous
row, missing control, unknown state, or organization policy is reported rather
than guessed. Toggle controls include buttons, checkboxes, and ARIA switches.

Defaults describe GitHub product defaults, not an organization's custom
configuration. Public repositories default graph, secret scanning, and push
protection to enabled; the other explicitly requested API settings default to
disabled. Copilot Autofix is enabled by default for repositories using CodeQL,
subject to eligibility and policy, as documented in
[GitHub's Autofix guidance](https://docs.github.com/en/code-security/concepts/code-scanning/autofix-for-code-scanning).
Dependabot on Actions runners also defaults to enabled where Actions is available,
as documented in [GitHub's runner guidance](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-on-actions).
The status output retains unknown defaults for newly discovered rows and unknown
visibility instead of claiming a difference. Private/internal defaults cannot
establish license eligibility or override inherited organization configuration.

GitHub also documents a newer runner-selection interface, alongside the older
self-hosted runner toggle:
[Dependabot runner configuration](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-on-self-hosted-runners).
A non-toggle configuration requiring runner labels or a group cannot be
represented by a boolean; the driver reports its row without inventing a label.

## Complete requirement inventory and evidence

| Requirement                                                 | Possible approaches and selected plan                                                                                                                                                                                                                 | Implementation and verification                                                                                                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #24: all of #22 and #23 in one PR                           | Separate PRs would violate the parent; implement shared gateways first, then doctor in this branch.                                                                                                                                                   | PR 25; separate `Fixes #24`, `Fixes #22`, `Fixes #23` references.                                                                                                                     |
| #22.1: private vulnerability reporting read/enable/disable  | Browser or dedicated endpoint; use GET/PUT/DELETE first with browser fallback.                                                                                                                                                                        | Shared feature registry and API; `security-extended.test.js` exercises both writes and reads.                                                                                         |
| #22.2: non-provider patterns                                | PATCH repository analysis property; verify secret scanning before enabling.                                                                                                                                                                           | Same tests cover exact property bodies, both states, and missing prerequisites.                                                                                                       |
| #22.3: validity checks                                      | Same approach with its separate analysis property.                                                                                                                                                                                                    | Same API/prerequisite fixture coverage.                                                                                                                                               |
| #22.4: CodeQL default setup                                 | GET/PATCH with state translation; parse workflows before enabling. Refuse advanced analyze/upload-sarif workflows and explain upload conflict.                                                                                                        | `security-extended.test.js`; doctor static/log rules; asynchronous API verification uses the existing poller.                                                                         |
| #22.5: Pages status/source                                  | POST absent site, PUT existing site, verified GET; Actions or branch with optional path.                                                                                                                                                              | `pages/manager.js`, `domains/pages.js`; `pages.test.js` covers creation, update, legacy paths, invalid inputs, idempotence, verification failure, CLI confirmation, dry-run and JSON. |
| #22: shared controls                                        | Reuse security domain generation and gateway rather than duplicate flags per setting.                                                                                                                                                                 | Every feature has enable/disable, yes, dry-run, JSON, status, idempotence, and verification; browser-only writes verify the page because no API exists.                               |
| #22.6: page-only rows                                       | Extend registry for grouped updates, Dependabot runners and Autofix; discover additional headings. Exact-heading writes avoid a global Enable button.                                                                                                 | `browser-security-extended.test.js`, `browser-security.test.js`, and gateway tests cover discovery, named writes, checkboxes, policy rows, ambiguity and locked controls.             |
| #22: status covers defaults by visibility                   | Return state, source, visibility, product default, and nullable difference for every row. Unknown remains explicit.                                                                                                                                   | `security-extended.test.js`, browser discovery and CLI status tests.                                                                                                                  |
| #23: repository, user, organization                         | Reuse paginated repo discovery; include forks and archives for the requested whole scope, plus accessible private repositories through owner/collaborator discovery.                                                                                  | Doctor integration tests and discovery tests; errors are isolated per repository.                                                                                                     |
| #23: report by default                                      | Keep inspection independent from optional confirmed repair.                                                                                                                                                                                           | Tests assert zero writes without fix, with dry-run, and after confirmation refusal.                                                                                                   |
| #23: Pages actions, all three names                         | Parse YAML step `uses`, require workflow Pages.                                                                                                                                                                                                       | Rule fixtures for deploy-pages, upload-pages-artifact, configure-pages.                                                                                                               |
| #23: dependency review / compare API                        | Require graph for review action and compare API in `run` steps.                                                                                                                                                                                       | Parsed workflow fixtures with file and line evidence; comments do not trigger rules.                                                                                                  |
| #23: advanced scanning                                      | Require default setup disabled for analyze and upload-sarif.                                                                                                                                                                                          | Separate action fixtures and verified repair integration.                                                                                                                             |
| #23: alerts                                                 | Require alerts for vulnerability checks (default on), and either Dependabot config extension.                                                                                                                                                         | Rules for default review, explicit opt-out, Dependabot config; graph and alert repair integration.                                                                                    |
| #23: latest failed logs for each workflow on default branch | Reuse run discovery/log retrieval, select latest run per workflow and failed jobs only.                                                                                                                                                               | Six phrase fixtures; default-branch query assertion; successful jobs and current successful runs ignored; expired logs remain scan errors.                                            |
| #23: every requested log phrase                             | Graph disabled/review unsupported -> graph; Pages failed/ensure enabled -> Actions source; advanced/default conflict -> disable default; scanning not enabled -> inspect default setup or manual entitlement/workflow diagnosis when advanced exists. | `doctor-rules.test.js` and `doctor.test.js`; stale scanning error cannot override currently enabled state.                                                                            |
| #23: evidence and fixability                                | Combine identical requirements and preserve each file/line or run URL/log line, current/required values, reasons and fixability.                                                                                                                      | Read-only report integration asserts both evidence sources and actual source lines.                                                                                                   |
| #23: confirmed repairs and verification                     | Use shared security and Pages gateways; ineffective writes remain unresolved. Unknown/policy states require manual action.                                                                                                                            | Integration tests exercise actual REST fixtures and browser fallback, confirmation plan and ineffective writes.                                                                       |
| #23: reruns and opt-out                                     | Rerun failed jobs only for log evidence tied to a setting actually changed and verified; recheck branch/failure before POST.                                                                                                                          | Tests cover causal rerun, static-only evidence, no-rerun, failed repair, successful-job exclusion.                                                                                    |
| #23: nonzero remaining and bulk continuation                | Count unresolved findings and scan errors; continue other repositories.                                                                                                                                                                               | Doctor CLI and manager tests cover exit status and an inaccessible first repository.                                                                                                  |
| Distribution/library compatibility                          | Extend registry, domain dispatch, CLI args, public exports, declarations, examples and docs together; retain all existing commands.                                                                                                                   | Full runtime suites, entry-point and CLI tests, declaration probe in experiments.                                                                                                     |
| Release preparation                                         | Minor Changeset rather than a manual version edit, per contributing instructions.                                                                                                                                                                     | `.changeset/repository-settings-doctor.md`.                                                                                                                                           |

## Reproduction and validation

Before implementation, the missing API features and Pages module failed the new
security/Pages tests; doctor imports and page-row discovery also failed their
new fixture tests. These are deterministic reproductions, with no live
repository settings mutated during tests.

Run the suites with `npm test`, `bun test --timeout 30000`, and
`deno test --allow-read --allow-write --allow-env`. `npm run check` checks lint,
formatting and duplication against main. Focused reproduction tests are in
`tests/security-extended.test.js`, `tests/pages.test.js`,
`tests/doctor-rules.test.js`, `tests/doctor.test.js`, and
`tests/browser-security-extended.test.js`. The read-only example is
`examples/diagnose-repository.js`. The Playwright MCP probe in
`experiments/security-browser-probe.js` verifies actual Chromium checkbox state
after a click, policy state, and dynamic row discovery; the browser is closed
afterward. A TypeScript compile probe verifies the public declarations.

The initial PR Security run (40084922403, original head
`1be137526001e5a970a74c158c1e920a4c27dcb9`) failed its example npm audit.
The preserved log identified Electron GHSA-jr5w-w6x2-84p9 at lines 510–515,
fast-uri at 516–523, undici at 525–533, and Vite at 536–544.
Updating compatible versions in the example lockfile removes those advisories;
no example functionality or dependency range was removed.

## First npm publication: external blocker

The distribution note in #22 is a separate operational requirement and is still
unfinished. On 2026-10-24, `npm view @link-foundation/gh-manager version` returned
E404 and `npm whoami` returned ENEEDAUTH. No npm browser session or publisher
profile is present in this container. GitHub authentication cannot authorize an
npm organization publish. No unauthenticated publish is reported as successful.

[package-registry-manager](https://github.com/link-foundation/package-registry-manager)
already supplies the requested bootstrap and trusted-publisher setup, including
npm web login and approval in a dedicated browser profile. Once the npm owner
has authenticated, its documented setup command is:

```bash
npx package-registry-manager setup --repository . --registry npm --execute
```

It requires the owner's npm sign-in/2FA approval. The existing release workflow
already uses OIDC; a minor Changeset prepares the next version in this PR.
[npm's trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/)
explains the package settings and workflow binding. This PR remains unmerged;
first publication and publisher attachment must not be counted as verified
until the registry actually accepts them.
