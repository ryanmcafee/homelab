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

## PR #459 integration control (2026-09-28)

- Security reviewed gate commits `4cd65ad` and `4e8a338`; no blocking defect within the inline-values contract. Architect review remains required before merge.
- Captured `positive/workflows-auth-client.yaml` by rendering exact PR #459 head `620940d59fce248a9078a13593e82b477334f841` with `go run ./cmd/homelab verify render --env homelab --chart addons --out-dir <capture-dir>` (6 checks passed). Selected the Application named argo-workflows, normalized only the example domain, and added a provenance comment. Client auth and enabled HTTPRoute are unchanged.
- Positive conftest command documented in tests/policy/README.md: exit 0, 30/30 checks. Preserved negative: exit 1, exactly one workflows-auth violation. SSO and route-disabled controls remain.
- `task test:policy`: 119 Rego tests and 44 fixture/coverage checks passed in 2.928s (prior 43-check run this heartbeat: 3.003s; single samples, not a benchmark).
- `task verify:text` on PR #459 plus gate files: exit 0, 270 passed / 0 failed / 1 skipped, 13.822s wall. Shared tree: exit 201, 269 passed / 1 failed / 1 skipped, 13.971s wall; only unsafe Workflows policy failed.
- Reproducibility: integration used PR #459 unchanged auth wiring, example configuration and no cluster or credentials. Local integrated pass does not claim remote CI, runtime RBAC or OIDC verification.

## Additive auth-input regression gate (MCAA-543, 2026-09-28)

- ADR-050 D11a: validate singular `authMode`, list `authModes`, and `extraArgs` together. Require at least one explicit mode and only `sso`/`client`; reject unsafe modes and uninspectable argument shapes. Canonical unrelated `--flag=value` arguments remain supported. See `tests/policy/README.md` for the exact contract.
- Before changing the rule, added three negative fixtures derived from the captured PR #459 client control. `task test:policy` failed all three: plural server, plural hybrid, extraArgs server each reported no denial. 119 existing Rego tests still passed; fixture harness reported 3 mismatches of 47. Wall time 7.049s.
- After hardening: `task test:policy` passed 124 Rego tests and all 47 fixture/coverage checks in 5.572s. Single local samples (not a benchmark); no observed runtime regression. Client, SSO and disabled-route controls pass. No secrets or cluster required.
- Integrated validation on current main `17cb553` plus unchanged PR #459 `620940d` and existing gate commits: `task verify:text` passed 271 checks / 0 failed / 1 skipped in 18.153s wall (14.562s verifier time). No rendered values were edited for this fix. The known unsafe base posture remains PR #459's separate responsibility and must not wait for this gate.
- `workflows-auth` remains in `ALL_RULE_IDS`. External HTTPRoutes remain outside this rule's visibility (D10); runtime OIDC/RBAC are outside scope.
- Security and Principal Platform Architect review are required before merge; this work does not authorize merging or changing the authentication posture.
- Serena and bd are unavailable in this harness; Paperclip carries task tracking and this note preserves the discovery. Shared working-tree edits were untouched.
- Final review branch is stacked on PR #459's current head `eaa44da` (which already includes the original gate). Only policy, tests and documentation differ. Level 0 on that exact base plus hardening: 270 passed / 0 failed / 1 skipped, 11.072s wall (9.516s verifier time). This keeps the posture PR independently mergeable; retarget the gate PR after #459 merges.
