---
'@link-foundation/gh-manager': minor
---

Add the gh-manager CLI: a globally installable browser-automation tool for the
GitHub package operations the REST and GraphQL APIs do not expose.

- `gh-manager auth login|status|logout` signs in once in a dedicated Chrome
  profile under `~/.gh-manager/`, so SSO and 2FA carry over to later runs.
- `gh-manager package list|public|private|internal|delete` changes visibility
  and deletes packages, targeting explicit names or a `--pattern` glob
  (`--regex` for a regular expression).
- `gh-manager permissions list|grant|revoke|sync` reads and changes
  package-level team and user access, including `--from policy.json`.
- `gh-manager config list|get|set|unset` stores defaults such as `org`.
- Reads go through the API and writes through the browser, and every write is
  re-read afterwards; an empty API listing falls back to enumerating packages
  in the browser rather than reporting that there are none.
- Bulk runs print the resolved list, refuse over-broad patterns without
  `--all`, support `--dry-run` and `--yes`, and exit with codes a pipeline can
  branch on. Unexpected pages write a screenshot to `~/.gh-manager/logs/` and
  fail loudly.
- `gh-manager package permissions <verb>` is the same command as
  `gh-manager permissions <verb>`, so access reads as a property of a package.
