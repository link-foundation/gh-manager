---
'@link-foundation/gh-manager': patch
---

Recover Actions job discovery after bounded 5xx retries using validated source
check-runs and individual jobs. Keep run, SHA and attempt provenance, refresh
selected job identities across sequential reruns, and report unavailable
infrastructure explicitly without widening retries to unrelated failures.
