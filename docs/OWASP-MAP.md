# OWASP Top 10 (2025) map

Each item maps to the control that covers it and the automated test that proves it. A row is **done** only when both exist and the test runs in CI. The 2021 list maps onto the same controls.

| Item | Control | Test | Status |
|------|---------|------|--------|
| A01 Broken Access Control | API denies by default; Django admin not installed. Session check on every admin route, random IDs (phases 1, 2). | `api/tests/test_status.py` (default permission, `/admin/` returns 404). Per-route authorisation tests: TODO phase 1. | Started |
| A02 Security Misconfiguration | Debug off unless explicitly enabled; start-up refused without a secret key; `nosniff` and frame denial; non-root read-only containers. Full header set and CSP: phases 3, 6. | `api/tests/test_status.py` (debug off, plain errors, headers, missing secret). Header and CSP tests: TODO phase 6. | Started |
| A03 Software Supply Chain Failures | npm lockfile, pip installs with hashes, actions pinned to commit hashes, `npm audit`, `pip-audit`, Dependabot, CodeQL. SBOM, image scan, provenance: phase 6. | CI jobs `web`, `api`, `images`; CodeQL workflow. | Started |
| A04 Cryptographic Failures | TODO phase 1 (sessions, cookies, password hashing as shipped by Django) and phase 7 (TLS, HSTS, Secret Manager). | TODO | Not started |
| A05 Injection | ORM only; CI fails on `raw()`, `extra()` and direct cursors. Input schemas, output encoding, sanitised Markdown: phases 1 to 4. | CI step "No raw SQL". Payload tests: TODO phases 1 to 4. | Started |
| A06 Insecure Design | Threat model kept current; fail closed for writes, fail static for reads; security test written before the code. | `docs/THREAT-MODEL.md` review in the release checklist. Fail-closed tests: TODO phases 1, 4. | Started |
| A07 Authentication Failures | TODO phase 1 (passkey, server-side sessions, rotation, lockout with cool-down, generic responses). | TODO | Not started |
| A08 Software or Data Integrity Failures | Hash-pinned dependencies and actions. Audit hash chain (phase 1), build provenance (phase 6). | CI installs with `--require-hashes` and `npm ci`. Hash chain tests: TODO phase 1. | Started |
| A09 Logging and Alerting Failures | Logs to stdout only. Structured logs without personal data, audit log, alerts: phases 1, 5. | TODO | Not started |
| A10 Mishandling of Exceptional Conditions | Unknown routes return a plain 404 with no trace or version. Fail-closed behaviour when a dependency is down: phases 1, 4. | `api/tests/test_status.py` (plain errors). Dependency-down tests: TODO phases 1, 4. | Started |
