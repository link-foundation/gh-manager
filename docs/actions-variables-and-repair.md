# Actions variables and verified repair-to-CI

`createVariableManager` and `createRepairVerifier` are stable exports from
`@link-foundation/gh-manager`. A publishing manager supplies the real account
profile, desired variable name/value/scope, affected CI evidence and verified
changes. gh-manager has no registry account discovery, policy creation or
credential fallback logic.

## Variable API and CLI

```js
import {
  createRestClient,
  createVariableManager,
} from '@link-foundation/gh-manager';

const rest = createRestClient({ token: process.env.GH_TOKEN });
const variables = createVariableManager({
  rest,
  scope: { repo: 'owner/project' },
});
const change = await variables.ensure('NUGET_USER', 'actual-registry-profile');
if (!change.verified) throw new Error(change.reason);
// Repeating ensure returns changed:false and freshly verifies effective state.
await variables.list();
await variables.get('NUGET_USER');
await variables.effective('NUGET_USER');
await variables.delete('CALLER_CHOSEN_OBSOLETE_VARIABLE', { dryRun: true });
```

```sh
gh-manager variable ensure NUGET_USER --value actual-registry-profile --repo owner/project --json
gh-manager variable ensure CUSTOM_NAME --value arbitrary-value --repo owner/project --env production --dry-run
gh-manager variable ensure CUSTOM_NAME --value arbitrary-value --org owner --visibility selected --repos project,other
gh-manager variable list --repo owner/project
gh-manager variable get CUSTOM_NAME --repo owner/project --env production --effective
gh-manager variable delete CUSTOM_NAME --repo owner/project --yes
```

Use exactly one scope: `{ repo: 'owner/project' }`,
`{ repo: { owner: 'owner', name: 'project' }, environment: 'production' }`, or
`{ org: 'owner' }`. An environment must already exist; ensuring a variable does
not create or change environment protection rules. Values are **non-secret**,
may be empty, and are limited to 48 KiB. Use the secret API for credentials.
Names are normalized to uppercase and cannot start with a digit or `GITHUB_`.
These commands never modify gh-manager's local `config set` defaults.

`get` reads only the selected scope. `effective` reads applicable organization
variables through the repository endpoint, then repository and supplied
environment state. The result includes the winning `value`, `scope`, and all
`candidates`, in ascending precedence. Repository values override organization
values; an environment value wins for a job using that environment. GitHub only
makes environment variables available after the job starts; this does not prove
that a workflow's earlier expressions or explicit `env` assignments use that
value. See [GitHub's variable precedence rules](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#configuration-variable-precedence).

Repository/environment `ensure` verifies its own consumer context. Organization
`ensure` verifies repository contexts supplied in `repos`; use
`contexts: [{ repo: 'owner/project', environment: 'production' }]` to specify
other consumer contexts in the library. Without consumer contexts, an
organization ensure verifies only organization state, and `effective` is empty.
The caller must supply every environment it needs checked. A shadowed desired
value returns `verified:false` with `reason:'effective-state-mismatch'`; the CLI
exits 6. A repeated equal ensure performs only reads and returns `changed:false`.

Existing organization visibility and selected repositories are retained.
Explicit `repos` adds selected grants without removing other consumers.
New organization variables default to `selected` and require repository names;
creating `all` or `private` visibility requires an explicit caller choice.
Ensure refuses to change an existing visibility policy. A permission failure
never widens visibility or silently switches to repository variables.

Read access requires fine-grained **Variables** permission at repository or
organization scope, or **Environments** permission for environment variables.
Changes need write access. Classic organization tokens need `admin:org`, with
`repo` for private repositories. Errors preserve HTTP status and name the needed
permission. A single-variable 404 is absence only if inventory access succeeds;
403, inaccessible inventories, immutable policies and unsupported settings stay
errors. Writes are followed by read-back checks of values, visibility and selected
grants. `verificationTimeout` defaults to 15000 ms. A mismatch exits 6. Dry runs
read and validate but perform no writes and cannot provide verified repair evidence
for a proposed change. See the [official variable REST API](https://docs.github.com/en/rest/actions/variables).

Every operation added here has a supported REST API. There is no browser fallback
for denied variable access. Existing security/package gateways continue to use
browser-commander and state verification for settings with no usable API.
Authentication or authorization denial is never configuration success.

## Repair evidence and final CI verification

```js
import { createRepairVerifier } from '@link-foundation/gh-manager';

const result = await createRepairVerifier({ rest }).verify({
  repo: 'owner/project',
  workflow: 'release.yml',
  runId: 123456,
  jobIds: [987654],
  changes: [change], // an actual verified ensure result, not a dry-run plan
  requiredPermissions: [
    { job: 'publish', permission: 'id-token', level: 'write' },
  ],
  timeout: 600000,
});
if (result.status !== 'success') {
  // A skipped no-op or prerequisite is not evidence of successful CI.
  console.log(result);
}
```

The caller supplies the run and affected failed job IDs, discovered with `runs`.
Their workflow, membership and failed status are checked again before starting
CI. Every supplied change must be verified. A no-op skips all CI writes. If all
failed jobs are selected, the verifier requests `rerun-failed-jobs`; a subset uses
individual job reruns, including GitHub's automatic dependent-job reruns, and waits
between attempts. No other workflow is selected. An already successful or active
run is skipped. A concurrent rerun rejection remains an error.

Settings-only repair reuses the failed run's SHA. It waits for an incremented
`run_attempt` and reads the jobs of that exact attempt. Successful HTTP acceptance
is insufficient: `success:true` requires a completed successful run and successful
execution of every affected job. Skipped/missing jobs, failed CI, a changed SHA,
and timeout cannot become success. Results include `runId`, `runAttempt`, `sha`,
`conclusion`, `runUrl`, and job/step evidence. A subset may fix the selected job
while another job keeps the overall run conclusion failed; that result remains
`success:false`.

For changed workflow code, add a verified workflow change and an explicit new
revision:

```js
const request = {
  repo: 'owner/project',
  workflow: 'release.yml',
  runId: 123456,
  jobIds: [987654],
  changes: [change, { kind: 'workflow', changed: true, verified: true }],
  revision: { ref: 'main', sha: '0123456789012345678901234567890123456789' },
  timeout: 600000,
};
const result = await createRepairVerifier({ rest }).verify(request);
```

The ref must resolve to that full SHA and differ from the old run. The verifier
reads workflow code at the new SHA, checks dispatch support, and dispatches once.
It uses the dispatch response's run ID when available; older 204 responses use a
before/after inventory restricted to new run IDs at the expected SHA. Concurrent
ambiguous runs remain unverified. A moving ref that produces another SHA fails
verification. There is no fallback to rerunning old code. See
[workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
and [rerun APIs](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run).

For push-only workflows, the caller can start the new revision after settings
verification (for example by merging its code PR), then supply `newRunId` to
monitor that run without dispatching. It must match the workflow and updated SHA.
Use `jobNames` if the new code renamed affected jobs. Without a dispatch trigger
or caller-started run, the result is an explicit code prerequisite. Library polling
budgets are milliseconds (`timeout:0` performs one observation); CLI `--timeout`
is seconds. HTTP request duration is governed by the supplied REST transport.

Caller-supplied `requiredPermissions` are checked against the named job in the
workflow at the tested SHA. Missing `id-token: write`, for example, returns
`status:'prerequisite'` and identifies the workflow/job/permission to change through
a code PR. Repository-wide default workflow permissions are never broadened.
Registry policy and actual OIDC exchange/publication verification stay with the
caller; successful GitHub CI alone does not establish package installability.

The CLI reads the same input object from a JSON file:

```sh
gh-manager repair verify ./repair-evidence.json --timeout 600 --json
gh-manager repair verify ./repair-evidence.json --dry-run --json
```

Success, skipped and dry-run commands exit 0; callers must inspect `status` to
distinguish them. Failed, timed out, unverified or prerequisite results exit 6.
API errors remain nonzero. The JSON file must represent actual verified changes;
it is evidence supplied by the caller, not an instruction to repair settings.
`--verbose` enables request-path and orchestration tracing without dumping tokens.

## Obsolete secrets

Repair verification never deletes secrets. Invoke generic `secret.cleanup` only
**after the caller has verified actual OIDC publication and workflow consumers**,
using explicit names, a reason, and a `verify` callback. A callback returning false
retains the secrets. Organization cleanup additionally audits every selected
repository; all/private visibility requires a provably complete organization
inventory. Remaining references, inherited/dynamic consumers, unreadable files,
or incomplete repository visibility retain the shared secret. The audit does not
prove external credential revocation; that remains a caller responsibility.

## Requirement and regression inventory

| Issue #29 requirement                                       | Implementation                               | Verification                                                                                |
| ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Caller-named CRUD at all scopes                             | `createVariableManager`, `variable` CLI      | `variables.test.js`, `variables-cli.test.js`                                                |
| Effective precedence, equal-state no-op, selected grants    | `effective`, `ensure`                        | Scope/override, unchanged-write-count and grant-preservation cases                          |
| Permission/not-found/unavailable/immutable/mismatch/dry-run | Verified REST variable API                   | 401/403/404/409/422, inaccessible inventory and ignored-write cases                         |
| Only verified relevant CI, bounded final evidence           | `createRepairVerifier`, `repair verify`      | `repair-verification.test.js`, `repair-cli.test.js`                                         |
| Updated workflow SHA                                        | Dispatch or monitor caller-started run       | `repair-revision.test.js`: new SHA, stale ref, wrong SHA, 204 response and missing dispatch |
| Minimum changes                                             | No-op skip, explicit workflow/job evidence   | No POST on no-op, unrelated workflow refusal, subset job rerun                              |
| Job permission as a code prerequisite                       | Caller-driven permission inspection          | Missing job `id-token` case, no default-permission writes                                   |
| Safe caller-directed cleanup                                | Existing callback plus complete shared audit | `shared-secret-cleanup.test.js`, existing callback refusal tests                            |
| No registry policy/long-lived credentials                   | Generic APIs and external caller boundary    | No registry login/dependency or token acquisition added                                     |

The two downstream issues linked in #29 are consumer context. They request changes
in their own repositories; no required child issue is part of this PR. The initial
regressions failed because both public factories were absent. Focused reproduction:

```sh
node --test tests/variables.test.js tests/variables-cli.test.js tests/repair-verification.test.js tests/repair-revision.test.js tests/repair-cli.test.js tests/shared-secret-cleanup.test.js
```
