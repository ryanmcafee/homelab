# OpenClaw live verification

`chainsaw-test.yaml` is discovered automatically by `task test:e2e` and reported as
`e2e/openclaw` by `task verify LEVEL=2`. Both run in `.github/workflows/tilt-ci.yml`
`kind-argocd` on the PR head. No local container runtime is required to author this suite.
Never run this against production. Every scripted kubectl invocation pins
`--context kind-homelab-localdev`. Chainsaw runs this test non-concurrently so the
intentional unhealthy interval cannot race the global Application checks.

```sh
chainsaw lint test -f tests/e2e/openclaw/chainsaw-test.yaml
task verify:text
# Docker-backed CI or an authorized Kind workstation only:
task test:e2e -- --test-dir tests/e2e/openclaw
task verify LEVEL=2
```

| Check | Expected evidence / failure condition |
| --- | --- |
| Applications | Exactly the two named assertions: openclaw-operator and openclaw Healthy/Succeeded. Dependencies is absent without a secret store. |
| Inventory | Names from the live CR's managedResources, fetched objects and matching owner UIDs: StatefulSet, Service, ConfigMap, PVC (Bound), ServiceAccount, Role, RoleBinding, NetworkPolicy. The externally seeded gateway Secret must exist and match the CR reference; claiming it is operator-created would be incorrect. Pod must be Ready, not merely Running. |
| Default env | Read live pod specs. OAuth variable present in primary container; all regular/init containers lack the three forbidden variables and bulk envFrom. Names only are reported. |
| Provider proxy | Live CR and runtime JSON select the native anthropic provider, OAuth reference and anthropic model prefix. Runtime JSON is evaluated inside the pod and never emitted. Readiness does **not** prove authentication. |
| Smoke | Parent Application's per-resource PostSync result must explicitly name smoke-openclaw as Succeeded. Render the actual parent chart helper, verify wave 13, replay its Job as qa-smoke-openclaw, assert Job Complete and its own HTTP 200 log. Successful hooks are deleted, so replay logs are not claimed to be the original hook's logs. |
| Negative health | Change only the Kind instance's gateway Secret reference to a deliberately nonexistent name. Require the real operator's Failed/Ready=False/ReconcileFailed mentioning that name, then the resource's and Application's Degraded health as computed by installed Lua. Restore the original reference, require Running/Ready/Healthy again. Never patch status. |
| API-key toggle | Render charts/openclaw with the Application values and adapters.apiKeys.anthropic.enabled=true; patch the resulting env onto the live Kind CR. Require updated StatefulSet rollout, Ready pod and an exact env-name delta of ANTHROPIC_API_KEY. Restore original env and recheck. This exercises chart toggle to operator reconciliation, not a second Argo sync operation. |
| RBAC | Enumerate every ClusterRoleBinding and referenced effective ClusterRole, including service-account groups and direct User subjects. Reject cluster-wide Secret permissions or wildcard verbs. Impersonate the complete SA identity: Secret get allowed in openclaw, denied in default, with exact yes/no and exit codes. |
| Routes | Enumerate every HTTPRoute; reject any backend targeting any Service in openclaw, and any route in openclaw parented to the shared internal Gateway. Other applications' internal routes are expected and provide a nonempty control; their mere existence is not an OpenClaw exposure. Operator and OpenClaw Service must already exist. |

## Deliberate limits and follow-up

- **Real credential acceptance remains unproven.** `localdev/fakes/secrets.yaml` uses placeholders.
  No inference request is attempted and no real token is needed in CI. The Chief of Staff's
  post-merge read-only verification must observe a successful native-provider inference using
  the separately authorized production credential; no credentials belong in CI evidence.
- **SSA counterfactual is excluded.** The suite checks the deployed operator Application enables
  SSA, and its actual sync succeeded. It does not claim client-side apply would fail. That needs
  an isolated disposable cluster/CRD client-side apply experiment, capturing the annotation-size
  rejection and successful SSA of the same pinned CRD. Changing the live shared CRD is unsafe and
  unnecessary for this acceptance gate.
- **API-key billing/authentication is not tested.** The toggle's placeholder key proves env wiring
  and reconvergence only; it does not prove a provider accepted that key.
- This suite does not verify an HTTPS surface: the service intentionally has no Gateway route.
  The helper probes plain in-cluster HTTP `/healthz`, asserting the helper's status-only contract;
  it does not assert a JSON body or TLS certificate that endpoint does not provide.
- `wait` reports observation counts for asynchronous convergence; it never retries an entire failed
  test. The helper's curl includes retries, so HTTP success is not evidence of first-attempt success.
  Record that limitation and any CI rerun when issuing a verdict.

## Recovery and evidence

The mutation script saves only original env references and gateway configuration to `.restore.json`
and restores in `finally`; Chainsaw also runs an independent recovery operation on failure/timeout.
If interrupted outside Chainsaw, from this directory run `bun ./check.ts restore` against the same
Kind cluster. Do not discard the restore file before recovery succeeds. Jobs created by the replay
are deleted in its finally block. No data, namespace, PVC or instance is deleted by this suite.

A release report must link the PR head SHA, `kind-argocd` run and job, state every check's actual
PASS/FAIL/unobserved outcome, and retain the authentication and SSA gaps above. A schema/lint pass
is not a live verdict. If bootstrap fails before Chainsaw, report that named job/step failure and
mark these assertions unobserved; never infer their results from chart rendering.
