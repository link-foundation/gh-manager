---
'@link-foundation/gh-manager': minor
---

Add `gh-manager security`: read and set a repository's "Code security and analysis" toggles, the dependency graph among them.

The dependency graph is why the domain exists. A repository whose graph is off fails `actions/dependency-review` with "Dependency review is not supported on this repository. Please ensure that Dependency graph is enabled", and GitHub exposes that toggle nowhere but the settings page — no REST endpoint, no GraphQL field, nothing in `security_and_analysis`. Flipping it has meant a human clicking through a browser.

- `gh-manager security status <owner>/<repo>` lists all five settings, reading each one through the API where an endpoint exists and falling back to the settings page where it does not, and says which answered.
- `gh-manager security dependency-graph|vulnerability-alerts|automated-security-fixes|secret-scanning|push-protection <owner>/<repo> --enable|--disable` sets one setting, through the API when GitHub offers one and through the browser when it does not.
- Every change is re-read before it is reported. The dependency graph is proven by `GET /repos/{owner}/{repo}/dependency-graph/sbom`, which GitHub builds asynchronously, so a `404` inside the verification window is treated as "not yet" and the settings page is consulted before the run gives up; the output names which confirmed the change.
- A setting already in the wanted state exits `0` and reports `changed: false`, so a re-run is not an error. `--json` carries `changed`, `changedBy`, and `verifiedBy` for a pipeline to branch on.
- Changes ask for confirmation unless `--yes` is given, `--dry-run` prints the plan and touches nothing, and a toggle an organization or enterprise policy owns fails with a non-zero exit and a screenshot plus the page HTML in `~/.gh-manager/logs/`.
- Push protection names secret scanning as its prerequisite and submits nothing GitHub would reject.
- `createSecurityGateway`, `SECURITY_FEATURES`, `SECURITY_FEATURE_IDS`, and `findSecurityFeature` are exported from the library surface, with types.
