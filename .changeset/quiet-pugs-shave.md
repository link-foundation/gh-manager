---
'@link-foundation/gh-manager': minor
---

Confirm deletions only from an explicit 404, detect over-broad patterns by what they match, and cache organization package settings in links notation.

An unreadable package was previously treated as a deleted one: every API read failure collapsed to `null`, and the delete check accepted `null` as proof, so a 403, a 5xx, or a network blip after the delete was submitted reported a successful deletion of a package that still existed. Reads now report `present`, `absent`, or `unknown`, and only an explicit 404 confirms a delete; `unknown` falls through to reading the page.

Over-broad patterns were recognized by spelling against a fixed set of strings, so `*` was caught while `?*`, `*?`, `***`, and the regular expression `.*.*` were not — each selecting every package while skipping the `--all` confirmation. Patterns are now judged by what they match.

Organization package settings are cached under `~/.gh-manager/org-settings/<org>.lino`, so a run no longer opens the organization settings page to re-read a value that changes about never. A cached entry is a hint, never an authority: a miss, an unparseable file, or an expired entry falls back to reading the page, and the page and the API remain the only things that confirm a change.
