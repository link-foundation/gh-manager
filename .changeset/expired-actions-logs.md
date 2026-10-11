---
'@link-foundation/gh-manager': patch
---

Treat expired/deleted Actions logs as typed unavailable evidence instead of aborting scans. Inspect the latest default-branch run per workflow, skip logs outside the configurable retention window, and report repository errors and scan progress while continuing organization scans.
