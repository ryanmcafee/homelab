# Workflows authentication policy gate (MCAA-467)

- Rule: `tests/policy/workflows-auth.rego`; contributor documentation and reproduction commands: `tests/policy/README.md`.
- Captured current homelab addons render at `0c748c1`: `server.authMode: server`, `server.httproute.enabled: true`. Parent source uses `server.route.enabled`; inspecting that key in the rendered upstream values misses exposure.
- Preserve `tests/policy/negative/workflows-auth.yaml` even after Security changes the auth wiring. Domain normalized to the fixture's example.com; no credential values or operator identifiers.
- No authorized deferral exists. The rule intentionally ignores generic exemption annotations and caller-supplied booleans. Future exceptions need a recorded Architect review and an explicitly scoped policy change.
- Local verification: `task test:policy` passed 119 Rego tests and 43 fixture/coverage checks. Wall time 3.268s versus 2.734s before this change (+0.534s; local samples, initial post-change run 3.631s).
- Known-bad command: `conftest test -p tests/policy --all-namespaces --data tests/policy/negative/_data.yaml tests/policy/negative/workflows-auth.yaml`; exit 1, `[workflows-auth] Application/argocd/argo-workflows: routed Workflows requires explicit server.authMode sso or client`.
- Required `task verify:text`: 10.797s wall after warming caches (initial run 23.578s), 269 passed, 1 failed, 1 skipped. The only failure is `policy/homelab` on the current rendered unsafe Workflows configuration. Task wrapper exit 201; verifier exit 1. This is expected enforcement, not a green full verification result.
- Every-PR wiring already exists: `.github/workflows/verify.yml` unfiltered `pull_request`, `level-0` job `task verify`, `policy` job `conftest verify -p tests/policy` and `bun scripts/policy-test.ts`. No workflow changes required.
- Residual limitations: static configuration gate only; no IdP, credentials, RBAC, or login-flow verification. Client auth is accepted as authenticated but does not fulfill OIDC acceptance. Mixed values/valuesObject and value files/parameters fail closed until effective-value resolution is implemented. Omitted HTTPRoute flag follows the disabled default.
- Security owns auth wiring and review before merge; this change does not edit charts/configuration. Full CI must be rerun on the integrated safe configuration.
- Serena and bd were unavailable in this session; task tracking is in Paperclip and this note. Unrelated shared-workspace edits were preserved.
- Commit sequence: initial gate `4cd65ad`, followed by mixed-representation hardening. Independent sub-agent file review was blocked by sandbox namespace failure; Security review remains required.
