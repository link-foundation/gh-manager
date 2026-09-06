# gh-manager

A globally installable CLI for the GitHub package operations the REST and
GraphQL APIs do not expose: flipping container package visibility, deleting
packages in bulk, and managing package-level permissions.

GitHub has no endpoint for any of those three. The only place they exist is the
web UI, so gh-manager drives a real browser for the writes, and uses the API for
the reads and for verifying that a write actually landed.

```bash
npm i -g @link-foundation/gh-manager
gh-manager auth login
gh-manager package public box box-dind --org link-foundation
```

## Features

- **One login, reused**: a dedicated Chrome profile in `~/.gh-manager/`
  survives SSO and 2FA, which a personal access token cannot carry
- **Hybrid strategy**: API reads, browser writes, API re-read to verify
- **No false "no packages found"**: an empty API listing falls back to
  enumerating the packages the browser can see
- **Safe bulk operations**: patterns are resolved against the packages that
  exist, the resolved list is always printed, and nothing destructive runs
  without a confirmation or an explicit `--yes`
- **Meaningful exit codes**: a pipeline can branch on the reason, not the text
- **Loud failures**: an unexpected page writes a screenshot and the HTML to
  `~/.gh-manager/logs/` and exits non-zero

## Install

```bash
npm i -g @link-foundation/gh-manager
gh-manager --version
```

Node.js 20 or newer, plus a browser you already have. The session is an
installed Chrome started by
[browser-commander](https://www.npmjs.com/package/browser-commander) with a
dedicated `--user-data-dir`; `--channel msedge|brave|chromium` picks another
one, and `--engine` picks the automation engine (`playwright` by default).

## Quick start

```bash
# Sign in once. A browser window opens; finish the login (SSO, 2FA, whatever
# your organization requires) and the session is stored in the managed profile.
gh-manager auth login

# Remember the organization so later commands do not repeat --org.
gh-manager config set org link-foundation

# What is there?
gh-manager package list

# Make two packages public, verified through the API afterwards.
gh-manager package public box box-dind

# Delete everything matching a glob, showing the plan first.
gh-manager package delete --pattern 'box-test-*' --dry-run
gh-manager package delete --pattern 'box-test-*'
```

## How it works

| Operation                  | Read          | Write   | Verify         |
| -------------------------- | ------------- | ------- | -------------- |
| List packages              | API → browser | —       | —              |
| Change visibility          | API           | Browser | API, then page |
| Delete a package           | API           | Browser | API, then page |
| List or change permissions | Browser       | Browser | Page re-read   |

`GET /orgs/{org}/packages?package_type=container` answers with an empty array
for a token without the package scopes. gh-manager treats an empty listing as
"the API cannot see them", not as "there are none", and enumerates the packages
page in the browser instead. The output says which source was used.

Verification is equally explicit. After a write, the API is re-read until it
agrees, for up to 15 seconds. If the API cannot see the package at all — no
token, or a token without scopes — that is reported as an absence of evidence
and the page itself is read instead. A change that cannot be confirmed either
way fails with `VERIFICATION_FAILED` (exit code 6); it is never reported as a
success.

## Commands

The grammar is `gh-manager <domain> <verb> [targets...] [flags]`. Run
`gh-manager --help` for the domain list, or `gh-manager <domain> --help` for a
domain.

### auth

```bash
gh-manager auth login    # open a browser window and wait for the sign-in
gh-manager auth status   # show the signed-in account and the API token in use
gh-manager auth logout   # delete the managed browser profile
```

`auth login` needs a visible window, so it refuses `--headless`. It waits up to
300 seconds by default; raise that with `--timeout <seconds>`.

### package

```bash
gh-manager package list --org link-foundation
gh-manager package public box box-dind --org link-foundation
gh-manager package private --pattern 'box*' --org link-foundation
gh-manager package internal box --org link-foundation
gh-manager package delete box-test --org link-foundation --dry-run
```

`--account <login>` targets a user account instead of an organization.
`--package-type <type>` selects the ecosystem (`container` by default).

`delete` always asks for a confirmation, even for a single explicitly named
package. The visibility verbs ask only when the list came from a pattern,
because a typed name is already a decision. `--yes` answers in advance, which
is what a non-interactive run needs; without a TTY and without `--yes`, the
command aborts rather than assuming consent.

### permissions

```bash
gh-manager permissions list --pattern 'box*' --org link-foundation
gh-manager permissions grant box --team maintainers --role write --org link-foundation
gh-manager permissions revoke --pattern 'box*' --user someone --org link-foundation
gh-manager permissions sync --from policy.json --org link-foundation --dry-run
```

Roles are `read`, `write`, and `admin`. `--team` and `--user` may be repeated.
`revoke` always asks; `grant` asks for pattern runs.

Because access is usually spoken about as a property of a package, the same
verbs are also reachable under `package`, and the two spellings are the same
command:

```bash
gh-manager package permissions list --pattern 'box*' --org link-foundation
```

### config

```bash
gh-manager config list
gh-manager config set org link-foundation
gh-manager config get org
gh-manager config unset org
```

`config list` also prints the path of the file it read.

Stored keys: `org`, `account`, `engine`, `channel`, `headless`, `packageType`.
Flags always win over what is stored.

## Targets, patterns, and safety

Targets are package names, or a `--pattern`. The two cannot be combined, and a
command that gets neither is a usage error.

- `--pattern 'box*'` is a **glob** by default: `*` matches any run of
  characters, `?` matches exactly one, and every other character is literal.
  A glob is anchored, so `box*` matches `box-dind` but `dind` matches nothing.
- `--regex` switches the same flag to a JavaScript regular expression, which is
  **not** anchored: `--pattern 'box' --regex` matches `sandbox` too. Anchor it
  yourself when that matters: `--pattern '^box(-dind)?$' --regex`.
- Both forms match case-insensitively.
- A pattern is always expanded against the packages that actually exist, and
  the resolved list is printed before anything is touched.
- A pattern that matches nothing exits with `NO_MATCHES` (4) and names the
  pattern and how many packages were considered. It never silently succeeds.
- An over-broad pattern (`*`, `**`, `.*`, `.+`, `^.*$`) is refused unless
  `--all` is passed, so a typo cannot expand to "everything".
- `--dry-run` prints the plan and stops before acting.

## Policy files

`permissions sync --from policy.json` converges package access onto a file:

```json
{
  "packages": [
    {
      "pattern": "box*",
      "teams": { "maintainers": "admin", "reviewers": "read" },
      "users": { "konard": "write" }
    },
    {
      "names": ["gh-manager"],
      "exclusive": false,
      "teams": { "maintainers": "write" }
    }
  ]
}
```

Each entry selects packages by `name`, `names`, or `pattern`. Grantees the
entry omits are revoked, which is what makes the file a policy and not a wish
list; set `"exclusive": false` when an entry should only add. Roles are
case-insensitive. Combine with `--dry-run` to see the grants and revokes a file
implies before applying it.

## Exit codes

| Code | Name                  | Meaning                                              |
| ---- | --------------------- | ---------------------------------------------------- |
| 0    | `SUCCESS`             | Every requested operation completed and was verified |
| 1    | `FAILURE`             | An operation failed (browser, GitHub, unexpected UI) |
| 2    | `USAGE`               | The command line was wrong                           |
| 3    | `AUTH`                | No usable browser session or token                   |
| 4    | `NO_MATCHES`          | The targets or pattern resolved to nothing           |
| 5    | `ABORTED`             | A confirmation was declined                          |
| 6    | `VERIFICATION_FAILED` | The action ran but could not be confirmed            |

In a bulk run one failure does not cancel the rest: the remaining packages are
still processed, the failures are listed, and the exit code reports the first
one.

## Application directory

```
~/.gh-manager/
├── config.json      # stored defaults
├── chrome-profile/  # the persistent browser profile
└── logs/            # failure screenshots and page dumps
```

Override the location with `--app-dir <path>` or `GH_MANAGER_HOME`, which is
what a CI runner or a second account needs.

## Authentication

Two independent credentials, used for different things.

**The browser session** performs every write. It is created once by
`gh-manager auth login` and stored in the managed Chrome profile. gh-manager
never sees a password.

**The API token** is only used for reads and verification, and is optional —
without one, gh-manager falls back to reading pages. It is resolved in this
order:

1. `--token <value>`
2. `GH_MANAGER_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`
3. `gh auth token`, so an existing GitHub CLI login just works

`gh-manager auth status` prints which source was used.

## Headless and CI

`--headless` runs the browser without a window, and every verb except
`auth login` supports it. A CI run needs three things:

1. An application directory holding a profile that is already signed in. Point
   `GH_MANAGER_HOME` at it, or restore it from a secret; the profile is the
   credential, so treat it as one.
2. `--yes`, because a destructive verb refuses to assume consent when there is
   no TTY.
3. A token in the environment, so changes are verified through the API rather
   than through a page read.

```bash
GH_MANAGER_HOME=/secure/gh-manager \
  gh-manager package public box --org link-foundation --headless --yes
```

If the profile has expired, the run fails with `AUTH` (3) and a screenshot,
which is the signal to refresh it with an interactive `gh-manager auth login`.

## When something goes wrong

Every page interaction waits for a condition and gives up with a clear message
instead of sleeping and hoping. When a page does not look the way the driver
expects, the failure writes `<label>.png` and `<label>.html` to
`~/.gh-manager/logs/` and names them in the error.

- `--verbose` prints the navigation and page-state trace.
- `--json` prints machine-readable output for `package list`,
  `permissions list`, and `config list`.
- All the GitHub selectors live in `src/browser/selectors.js`, so a UI change
  is a one-file fix.

## Known limitations

- Package **visibility** is a container-registry concept; npm and other
  ecosystems expose a different settings page, so `container` is both the
  default and the tested path.
- The browser drivers target the current GitHub UI. A redesign needs
  `src/browser/selectors.js` updated; the tests in `tests/browser-*.test.js`
  run against fixture pages and will fail loudly when a driver stops matching.
- `auth login` cannot run headless, by design.

## Library use

The package is also importable, which is how the tests and
`examples/basic-usage.js` exercise the pure parts (pattern resolution, policy
parsing, access diffing) with no browser and no token:

```js
import {
  matchPackageNames,
  parsePolicy,
  runCli,
} from '@link-foundation/gh-manager';
```

`runCli(argv, options)` returns an exit code and never calls `process.exit`, so
a whole command line can be run in process.

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test --timeout 30000

# Or with other runtimes:
npm test
deno test --allow-read

# Lint code
bun run lint

# Format code
bun run format

# Check all (lint + format + duplication)
bun run check

# Try the pure parts without a browser
node examples/basic-usage.js

# Build the universal React example app
npm install --prefix examples/universal-app
npm run example:web:build
npm run example:desktop:package
```

## Project Structure

```
.
├── .changeset/           # Changeset configuration
├── .github/workflows/    # GitHub Actions CI/CD
├── .husky/               # Git hooks (pre-commit)
├── bin/gh-manager.js     # CLI entry point
├── examples/             # Usage examples
│   └── universal-app/    # React + GitHub Pages + Electron + Capacitor app
├── scripts/              # Build and release scripts
├── src/
│   ├── browser/          # Page drivers and every GitHub selector
│   ├── cli/              # Argument parsing, prompts, entry point
│   ├── domains/          # Command domains: auth, package, permissions, config
│   ├── github/           # REST client and token discovery
│   ├── packages/         # The hybrid API/browser gateway
│   ├── permissions/      # Policy parsing and access diffing
│   ├── index.js          # Library entry point
│   └── index.d.ts        # TypeScript definitions
├── tests/                # Test files
├── eslint.config.js      # ESLint configuration
├── .prettierrc           # Prettier configuration
├── bunfig.toml           # Bun configuration
├── deno.json             # Deno configuration
└── package.json          # Node.js package manifest
```

## Design Choices

### Multi-Runtime Support

gh-manager runs on all major JavaScript runtimes:

- **Bun**: Primary runtime with highest performance, uses native test support (`bun test`)
- **Node.js**: Alternative runtime, uses built-in test runner (`node --test`)
- **Deno**: Secure runtime with built-in TypeScript support (`deno test`)

The [test-anywhere](https://github.com/link-foundation/test-anywhere) framework provides a unified testing API that works identically across all runtimes.

### Package Manager Agnostic

While `package.json` is the source of truth for dependencies, any of these work:

- **bun**: Primary choice, uses `bun.lockb`
- **npm**: Uses `package-lock.json`
- **yarn**: Uses `yarn.lock`
- **pnpm**: Uses `pnpm-lock.yaml`
- **deno**: Uses `deno.json` for configuration

Note: `package-lock.json` is not committed by default to allow any package manager.

### Universal App Example

`examples/universal-app` is a Vite React app that imports `matchPackageNames`
and `isOverBroadPattern` from `src/patterns.js` and lets you try a pattern against
a list of package names, including the over-broad check that protects bulk
operations. The same static build is used by:

- GitHub Pages (`npm run example:web:build`)
- Electron desktop packaging (`npm run example:desktop:package`)
- Capacitor Android/iOS sync (`npm run example:mobile:sync`)

The example app has its own `package.json` and lockfile, so React, Electron,
and Capacitor stay out of the published CLI package.

See [examples/universal-app/README.md](examples/universal-app/README.md) for
local web, desktop, Android, and iOS testing instructions.

### Code Quality

- **ESLint**: Configured with recommended rules + Prettier integration
- **Prettier**: Consistent code formatting
- **Husky + lint-staged**: Pre-commit hooks ensure code quality
- **File size limit**: Files must stay under 1500 lines for maintainability (enforced via ESLint and CI)

### Release Workflow

The release workflow uses [Changesets](https://github.com/changesets/changesets) for version management:

1. **Creating a changeset**: Run `bun run changeset` to document changes
2. **PR validation**: CI checks for valid changeset in each PR
3. **Automated versioning**: Merging to `main` triggers version bump
4. **npm publishing**: Automated via OIDC trusted publishing (no tokens needed)
5. **Optional Docker Hub publishing**: When configured, waits for the exact npm version and tags the Docker image with that version
6. **GitHub releases**: Auto-created with formatted release notes

> **First release of a brand-new package**: OIDC trusted publishing cannot
> create a package that does not exist yet (the first publish fails with
> `E404`, because a trusted publisher can only be configured for an existing
> package). To bootstrap, add a repository secret named `NPM_TOKEN` (a
> granular/automation token with publish access). The release workflow passes
> it as `NODE_AUTH_TOKEN` automatically. Once the package exists and OIDC
> trusted publishing is configured on npmjs.com, the token becomes optional and
> can be removed.

#### Manual Releases

Two manual release modes are available via GitHub Actions:

- **Instant release**: Immediately bump version and publish
- **Changeset PR**: Create a PR with changeset for review

### CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/release.yml`) implements a fast-fail pipeline:

**Fast checks** (~7-30s each, run first for fastest feedback):

1. **Test compilation**: Syntax-checks all `.mjs` files with `node --check`
2. **Lint, format & secrets scan**: ESLint, Prettier, jscpd, and [secretlint](https://github.com/secretlint/secretlint) for credential leak detection
3. **File line limits**: Enforces the 1500-line limit on JavaScript (`.js`, `.mjs`, `.cjs`) and Markdown (`.md`) files plus `release.yml`
4. **Changeset check**: Validates PR has exactly one changeset (added by that PR)
5. **Version check**: Blocks manual version changes in `package.json`
6. **Documentation validation**: Checks required doc files (doc line limits are enforced by the file line limits check)

**Slow checks** (only run after all fast checks pass):

7. **Test matrix**: 3 runtimes × 3 OS = 9 test combinations
8. **Broken link checks**: Validates all links in Markdown/HTML files (separate workflow)

**Release** (on merge to main):

9. **Changeset merge**: Combines multiple pending changesets at release time
10. **Release**: Automated versioning and npm publishing
11. **Optional Docker publish**: Publishes Docker Hub `latest` and npm-version tags after the npm package is visible

#### Reasonable Timeouts

Every CI job declares an explicit `timeout-minutes` so hung steps fail
in minutes instead of reaching the GitHub Actions default of six hours.
Fast checks use 5-10 minute caps, release jobs use 30 minutes, and the
link checker uses 10 minutes for external network variance.

That cap is a backstop, never the deadline: GitHub reports a job it
kills as **cancelled**, not **failed**. Long steps therefore own an
explicit budget via `scripts/run-with-budget-warning.sh`, which warns at
70% of the budget and fails the step with exit code 124 when it expires.
See [CI-TIMEOUT-BUDGETS.md](docs/CI-TIMEOUT-BUDGETS.md).

Individual tests are also capped inside supported runners:
`npm test` runs `node --test --test-timeout=30000`, and the CI Bun
runner uses `bun test --timeout 30000`. Both bound a _single test_, not
the suite, which is why the suite budget above exists. Deno does not
provide a single global per-test timeout flag, so Deno tests are
protected by their step budget and the matrix job backstop.

See [BEST-PRACTICES.md](docs/BEST-PRACTICES.md) for detailed explanations of each practice.

#### Robust Changeset Handling

The CI/CD pipeline is designed to handle concurrent PRs gracefully:

- **PR Validation**: Only validates changesets **added by the current PR**, not pre-existing ones from other merged PRs. This prevents false failures when multiple PRs merge before a release cycle completes.

- **Release-time Merging**: If multiple changesets exist when releasing, they are automatically merged into a single changeset with:
  - The highest version bump type (major > minor > patch)
  - All descriptions preserved in chronological order

This design decouples PR validation from the need to pull changes from the default branch, reducing conflicts and ensuring that even if CI/CD fails, all unpublished changesets will still get published when the error is resolved.

### Deploying the example app

The `example-app.yml` workflow deploys the universal example app to GitHub
Pages on every push to `main`. Before the first run on `main` in a new
repository created from this template, open **Settings → Pages** and set
**Source = GitHub Actions**. This is a one-time manual step and cannot be
configured from a workflow because the Pages source defaults to
_Deploy from a branch_. Without it, the `pages-deploy` job fails on
`actions/deploy-pages` with `Get Pages site failed` /
`Failed to create deployment`. After flipping the source, the workflow
provisions the Pages site on its first run.

### Auto-regenerated preview screenshots

The same `example-app.yml` workflow contains a `preview-regen` job that boots
the built example app in a headless Chromium via
[`browser-commander`](https://www.npmjs.com/package/browser-commander) +
Playwright and writes fresh screenshots to
`docs/screenshots/example-app/example-app-{locale}-{theme}.png` on every
push to `main` (and on `workflow_dispatch`). Any drift is committed back to
`main` with `[skip ci]` so README/site images never go stale between
releases. The job runs in the official Playwright container with the browser
already installed, avoiding CI stalls from live Chromium downloads.

The same script is available locally:

```bash
npm install --prefix examples/universal-app
npm run example:web:preview-images
# Verbose probe of <html data-theme>, <html lang>, and PNG signatures:
PREVIEW_VERBOSE=1 npm run example:web:preview-images
```

The matrix defaults to `{en, ru} × {light, dark}`. The shipped example app
has no localization or theme toggle yet, so every cell currently renders
the same UI — when a fork adds either, the matrix produces real per-cell
variants without script edits.

### Broken Link Checker

The link checker workflow (`.github/workflows/links.yml`) validates all links in Markdown and HTML files:

1. **Detection**: Uses [lychee](https://github.com/lycheeverse/lychee-action) to scan all `*.md` and `*.html` files
2. **Web Archive fallback**: For any broken links found, automatically checks the [Wayback Machine](https://web.archive.org) for archived versions
3. **Actionable suggestions**: Reports one of three outcomes for each broken link:
   - **Archived**: Suggests the Web Archive URL as a replacement
   - **Not archived**: Clearly reports the link is unrecoverable
4. **Scheduled checks**: Runs weekly to catch links that break over time (even if no files changed)
5. **Issue creation**: On scheduled runs, creates a GitHub Issue with the full broken links report

Add regex patterns to `.lycheeignore` to exclude URLs from checks (e.g., local dev URLs, example.com, known rate-limited sites).

## Configuration

### Package Name

The published name lives in `package.json` (`@link-foundation/gh-manager`) and
in `.changeset/config.json`. Release scripts read it from `package.json` at
runtime, so there are no package-name constants to keep in sync.

### Optional Docker Hub Publishing

Docker publishing is disabled by default. To enable it for a project that ships
a Docker image, add a `Dockerfile` and configure these GitHub Actions settings:

| Setting              | Type               | Description                                                                           |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `DOCKERHUB_IMAGE`    | Variable           | Docker Hub image name, for example `namespace/image`. This enables Docker publishing. |
| `DOCKERHUB_USERNAME` | Variable           | Docker Hub username used by `docker/login-action`.                                    |
| `DOCKERHUB_TOKEN`    | Secret             | Docker Hub access token used for registry authentication.                             |
| `DOCKER_CONTEXT`     | Variable, optional | Docker build context. Defaults to `.`.                                                |
| `DOCKERFILE`         | Variable, optional | Dockerfile path. Defaults to `./Dockerfile`.                                          |

When enabled, the release workflow waits until the exact published npm version
is visible in the npm registry, then publishes Docker Hub tags for `latest` and
that same version. The Docker build also receives `NPM_PACKAGE_VERSION` as a
build argument so Dockerfiles can install the matching published package.

### ESLint Rules

Customize ESLint in `eslint.config.js`. Current configuration:

- ES Modules support
- Prettier integration
- No console restrictions (common in CLI tools)
- Strict equality enforcement
- Async/await best practices
- **Strict unused variables rule**: No exceptions - all unused variables, arguments, and caught errors must be removed (no `_` prefix exceptions)

### Prettier Options

Configured in `.prettierrc`:

- Single quotes
- Semicolons
- 2-space indentation
- 80-character line width
- ES5 trailing commas
- LF line endings

## Scripts Reference

| Script                               | Description                                           |
| ------------------------------------ | ----------------------------------------------------- |
| `bun test --timeout 30000`           | Run tests with Bun and a 30s per-test cap             |
| `npm test`                           | Run tests with Node.js and a 30s per-test cap         |
| `bun run lint`                       | Check code with ESLint                                |
| `bun run lint:fix`                   | Fix ESLint issues automatically                       |
| `bun run format`                     | Format code with Prettier                             |
| `bun run format:check`               | Check formatting without changing files               |
| `bun run check`                      | Run all checks (lint + format)                        |
| `npm run example:web:dev`            | Start the universal app Vite dev server               |
| `npm run example:web:build`          | Build the universal app static web bundle             |
| `npm run example:web:preview-images` | Regenerate preview screenshots via browser-commander  |
| `npm run example:desktop:package`    | Package the Electron desktop app locally              |
| `npm run example:mobile:sync`        | Build and sync the app bundle into Capacitor projects |
| `bun run changeset`                  | Create a new changeset                                |

## Contributing

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed contribution guidelines.

Quick steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Create a changeset: `bun run changeset`
5. Commit your changes (pre-commit hooks will run automatically)
6. Push and create a Pull Request

## Best Practices

This template implements CI/CD best practices for AI-driven development. See [BEST-PRACTICES.md](docs/BEST-PRACTICES.md) for details on:

- File size limits for AI readability
- Automated formatting and linting
- Multi-runtime and cross-platform testing
- Changeset-based versioning
- Concurrency control for CI/CD pipelines

## License

[Unlicense](LICENSE) - Public Domain
