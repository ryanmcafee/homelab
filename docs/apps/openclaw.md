# openclaw

[OpenClaw](https://openclaw.rocks/) is an open-source AI agent ("the AI that really does things").
It runs through [openclaw-operator](https://github.com/stubbi/openclaw-operator), published by the
same maintainer as `paperclip-operator` (#260), so this deployment follows the Paperclip layout and
reuses its credential pattern. Issue #425.

## Applications

Three `Application`s, plus the two namespaces as raw `Namespace` resources rather than Applications,
are rendered by `charts/applications/templates/openclaw.yaml`, gated on `openclaw.enabled`, and never
part of a PR preview (an operator, CRDs and 1Password items are cluster-level concerns). They run in
both environments (Kind included), except `openclaw-dependencies`, which only exists where a secret
store does (`SECRETS_PROVIDER=onepassword`): Kind seeds its two Secrets from
`localdev/fakes/secrets.yaml` instead. A Kind cluster therefore shows **two** OpenClaw Applications,
a `SECRETS_PROVIDER=onepassword` cluster **three**.

| Wave | Resource | Source | What it deploys |
|---|---|---|---|
| 10 | Namespaces `openclaw-system`, `openclaw` (raw resources, not Applications) | inline (PodSecurity `baseline`) | targets for the Applications below |
| 11 | `openclaw-operator` | OCI chart `ghcr.io/paperclipinc/charts/openclaw-operator` 0.40.0 (repository Secret `paperclipinc-oci`), `ServerSideApply=true`, CRDs kept | `openclaw.rocks` CRDs + controller, ServiceMonitor on |
| 12 | `openclaw-dependencies` (secret store only) | `charts/openclaw-dependencies` | `OnePasswordItem`s `openclaw-api-keys`, `openclaw-gateway` |
| 13 | `openclaw` | `charts/openclaw` | `openclaw.rocks/v1alpha1` `OpenClawInstance` `openclaw` + PostSync smoke Job `smoke-openclaw` |

The repository Secret `paperclipinc-oci` is rendered once by
`charts/applications/templates/openclaw.yaml`'s sibling `paperclip.yaml`: both operators come from
`ghcr.io/paperclipinc/charts` and ArgoCD keys repository Secrets by URL, so a second copy would be
two names for one credential.

The `OpenClawInstance`: image `ghcr.io/openclaw/openclaw` at `images.openclaw` (the CRD rejects an
Instance whose tag and digest are both empty, and the registry publishes release tags without the
leading `v`); no `spec.networking.httpRoute` (see [Exposure](#exposure) -- the Control UI is
reachable in-cluster only); Service `openclaw` with
the operator's default gateway port 18789 and canvas port 18793; persistence on
`STORAGE_CLASS_ISCSI_SSD` at `OPENCLAW_STORAGE_SIZE` (1Gi in Kind); `spec.gateway.existingSecret`
pointing at `openclaw-gateway`; metrics and a ServiceMonitor on. The smoke Job curls
`http://openclaw.openclaw.svc.cluster.local:18789/healthz`, which is unauthenticated — the Control
UI itself needs the gateway token.

### CRD size

The `OpenClawInstance` CRD renders to **639,539 bytes (~625 KiB)**, far past the 256 KiB cap on
kubectl's `last-applied-configuration` annotation, so `openclaw-operator` is listed in
`tests/gitops/huge-crd-charts.yaml` and its Application must keep `ServerSideApply=true`. Measured,
not assumed:

```bash
helm template oc oci://ghcr.io/paperclipinc/charts/openclaw-operator --version 0.40.0 \
  --show-only templates/crds/openclaw.rocks_openclawinstances.yaml | wc -c
# 639539
```

`OpenClawClusterDefaults` (19,194 B) and `OpenClawSelfConfig` (5,751 B) are small; all three schemas
are vendored to `tests/schemas/openclaw.rocks/` by `task schemas:vendor`.

### Chart signature

The chart is OCI-only and cosign-signed keyless. Verify a version bump before trusting the tag — the
release workflow of the publishing repository is the only accepted signer:

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/paperclipinc/openclaw-operator/.github/workflows/release.yaml@refs/tags/v0.40.0 \
  ghcr.io/paperclipinc/charts/openclaw-operator:0.40.0
```

0.40.0 verifies at digest `sha256:346fe941...67e08`, signed by workflow `Release` at
`refs/tags/v0.40.0`.

## Configuration keys

| Key | Meaning |
|---|---|
| `OPENCLAW_HOSTNAME` | `openclaw.<domain>`; recorded for the future tailnet endpoint, no route is rendered today (see [Exposure](#exposure)) |
| `OPENCLAW_STORAGE_SIZE` | data volume size (agent workspace, `openclaw.json`, browser profiles); Kind always uses 1Gi |
| `OPENCLAW_API_KEYS_1P_PATH` | 1Password item for the provider credentials |
| `OPENCLAW_GATEWAY_1P_PATH` | 1Password item for the Control UI bearer token |

## Secrets

| Secret | Fields | Read by |
|---|---|---|
| `openclaw-api-keys` | `ANTHROPIC_OAUTH_TOKEN`, and `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` only where a toggle asks | `spec.env`, one optional `secretKeyRef` per wired variable |
| `openclaw-gateway` | `token` | `spec.gateway.existingSecret` |

1Password field labels become the Secret keys, and the Secret keys are the environment variable
names. Nothing is ever committed: Kind seeds both Secrets from `localdev/fakes/secrets.yaml`.

`OPENCLAW_API_KEYS_1P_PATH` is a **separate item** from `PAPERCLIP_API_KEYS_1P_PATH` with the same
field names, rather than the two stacks sharing one item. **This is a default, not a decision the
board made**: it buys independent rotation and a smaller blast radius, and costs one more item to
keep in sync. Pointing both at one item is a one-line change in
`configuration/templates/helm-apps.tmpl`.

## Agent credentials: subscription by default, API keys per provider

This is the part of the stack most likely to cost money by accident, so it is wired explicitly.

- **One Secret** (`adapters.secretName`), field names equal to environment variable names.
- **Each variable is named individually** under `spec.env` as an optional `secretKeyRef`. The chart
  never references the Secret as a whole. The upstream OpenClaw samples do
  (`envFrom: [secretRef: {name: openclaw-api-keys}]`), which exposes every key the Secret holds at
  once — including a provider key nobody enabled. `optional: true` means a field the item does not
  carry simply leaves the variable unset instead of blocking the pod.
- **Rotation still works.** The operator watches `env[].valueFrom.secretKeyRef` as well as whole-Secret
  references (`docs/external-secrets.md` upstream), so a rotated Secret still rolls the pod.

### The subscription variable is `ANTHROPIC_OAUTH_TOKEN`, not `CLAUDE_CODE_OAUTH_TOKEN`

`charts/paperclip` carries the Claude subscription token in `CLAUDE_CODE_OAUTH_TOKEN`. **OpenClaw's
native Anthropic provider -- the path this chart wires -- does not read that variable.** Its
credential list names only the other two, in both places that spell it out at `v2026.9.6`:
`extensions/anthropic/provider-contract-api.ts` declares
`envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]`, and `src/secrets/provider-env-vars.ts`
maps `anthropic` to the same pair. This chart wires that path -- `providerEnvPrecedence` feeds
`config.models.providers` -- so an `OpenClawInstance` carrying `CLAUDE_CODE_OAUTH_TOKEN` reads as
though it has subscription auth and has none, and `tests/policy/openclaw.rego` rejects it outright.

Note what is *not* the reason: `CLAUDE_CLI_CLEAR_ENV` (`extensions/anthropic/cli-constants.ts`) does
strip inherited credentials on the `claude-cli` paths, but it lists **both**
`ANTHROPIC_OAUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`, so it cannot distinguish them. The provider's
own `envVars` list is what does.

`ANTHROPIC_OAUTH_TOKEN` takes the **same** `claude setup-token` credential: the provider's
`setup-token` auth method is documented as "Paste a long-lived token created with
`claude setup-token`". The cost model is therefore unchanged from Paperclip's; only the variable name
differs.

One difference worth knowing, because it runs the opposite way to Claude Code: OpenClaw ranks
`ANTHROPIC_OAUTH_TOKEN` **above** `ANTHROPIC_API_KEY` -- it is the first entry of both lists cited
above. An API key that leaks into the Secret cannot silently move spend to metered billing the way it
does for Paperclip. It still must not be in the pod unless someone asked for it.

### Subscription (Claude Pro/Max/Team) — the default path

On a workstation logged into the subscribed account:

```bash
claude setup-token      # opens the browser, prints a long-lived sk-ant-oat01-... token
```

Store it as field `ANTHROPIC_OAUTH_TOKEN` of the `OPENCLAW_API_KEYS_1P_PATH` item and leave both
`adapters.apiKeys.*.enabled` at `false`. This is what the committed values do.

### API keys (per-token billing)

Enable only the provider you pay per token, in `charts/openclaw/values.yaml`. Each toggle is
independent and enabling one never adds the other's variable:

- **Anthropic**: `adapters.apiKeys.anthropic.enabled: true` and put `ANTHROPIC_API_KEY` in the item.
  Note that the subscription token still outranks it if both are present.
- **OpenAI**: `adapters.apiKeys.openai.enabled: true` and put `OPENAI_API_KEY` in the item. OpenClaw
  resolves OpenAI as `["CODEX_API_KEY", "OPENAI_API_KEY"]`; this chart wires only the latter.

### Provider allowlist

Every wired provider also gets an entry under `spec.config.raw.models.providers`, pointing at that
provider's highest-precedence wired variable (`adapters.providerEnvPrecedence` mirrors OpenClaw's own
`CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES`). A provider with no wired credential is not rendered at all.

That block is listed in `spec.config.forcePaths`, so the operator deletes and rebuilds it from the CR
on every pod restart. This matters because `config.mergeMode: merge` is what keeps runtime changes
(channels, settings) across restarts, and without `forcePaths` an agent could persist its own
`models.providers.<rogue>.apiKey` through the Control UI and route inference through a third-party
key while spending this cluster's compute. `gateway` is forced for the same reason.

### What the tests prove

A passing render proves nothing here; the absence assertions do.

- `scripts/openclaw-credentials_test.ts` renders the chart at its committed values and asserts the
  **exact** set of environment variables: default is `[ANTHROPIC_OAUTH_TOKEN]` and the render does
  not mention `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
  anywhere; each toggle adds exactly one variable; no combination renders a whole-Secret reference.
- `tests/policy/openclaw.rego` enforces the same contract structurally over every rendered
  environment: `openclaw-envfrom`, `openclaw-dead-credential`, `openclaw-credential-ref`,
  `openclaw-provider-unwired`.

```bash
bun test scripts/openclaw-credentials_test.ts
task test:policy
```

## Gateway token rotation

The Control UI bearer token is the `token` field of the `openclaw-gateway` item. It is supplied
rather than generated on purpose: without `spec.gateway.existingSecret` the operator generates a
token that exists only in the cluster, so rotation and recovery are invisible to git.

To rotate:

1. Replace the `token` field of the `OPENCLAW_GATEWAY_1P_PATH` item with a fresh value.
2. The 1Password Operator refreshes Secret `openclaw-gateway`; the operator watches it and rolls the
   pod. Confirm with `kubectl --context homelab-readonly -n openclaw get openclawinstance openclaw`
   returning to phase `Running`.
3. Every Control UI client has to present the new token; there is no grace period where both work.

## Self-config posture

`spec.selfConfigure.enabled: false`. **This is a default, not a board decision.** Agents requesting
changes to their own spec through `OpenClawSelfConfig` is a privilege-escalation surface, and the
paths that matter most (`models.providers`, `gateway`) are exactly the ones `config.forcePaths`
protects. If it is ever enabled, `allowedActions` must be set too: the CRD treats an empty list as
"nothing allowed" (fail-safe), so `enabled: true` alone grants nothing and only looks like it does.

One further default recorded here rather than decided:

- **No messaging channels** (Slack/Discord/Telegram) in v1. They would add a second credential store
  with no stated requirement.

## Exposure

**No route is rendered.** The Control UI is reachable only from inside the cluster, via Service
`openclaw.openclaw.svc.cluster.local:18789`; use `kubectl port-forward` to reach it.

An earlier revision of this document called `envoy-internal` "Tailscale-only". It is not.
`configuration/templates/helm-addons.tmpl` provisions that Gateway for the LAN *and* the tailnet, so
a route on it answers every client on the home network. The requirement for OpenClaw is
tailnet-only, and the gateway bearer token alone is not that boundary: it is one shared secret in
front of an agent holding a Claude subscription token and provider API keys.

There is also deliberately no route on the external Gateway, which would need oauth2-proxy in front.

Two rules hold this shut, both at level 0 (`task test:policy`):

| Rule | Forbids |
|---|---|
| `openclaw-shared-route` | an `OpenClawInstance` httpRoute, or the instance Application's inline values, naming `envoy-internal` |
| `openclaw-operator-scope` | the operator Application rendering without `watchNamespaces` |

Remote access needs a dedicated tailnet endpoint with tag-scoped authorization, which is tracked
separately; re-enabling the shared internal route instead is a board decision, not a default, and
would need this section and both rules changed with it.

## Controller RBAC scope

The operator Application sets `watchNamespaces: [openclaw]`. This is not cosmetic: with the list
empty -- the signed chart's default -- `templates/rbac.yaml` binds the controller a **ClusterRole**
granting Secrets `get, list, watch, create, update, patch` in *every* namespace. Naming the instance
namespace renders instead:

| Object | Namespace | Secret verbs |
|---|---|---|
| `Role/openclaw-operator-manager-role` | `openclaw` | get, list, watch, create, update, patch |
| `Role/openclaw-operator-manager-role-operator-ns` | `openclaw-system` | get, list, watch |
| `ClusterRole/openclaw-operator-manager-role-cluster` | cluster-scoped | none |

The remaining ClusterRole exists because `OpenClawClusterDefaults` is cluster-scoped; it grants no
Secret access. Residual risk: a compromised controller still reaches credentials in `openclaw` and
`openclaw-system`.

## Backups: not implemented, and why

The operator ships backup and restore Jobs plus a CronJob (`spec.backup`, `spec.restoreFrom`,
`docs/backup-restore.md` upstream), and `status` exposes `lastBackupTime` / `lastBackupPath`.
**Nothing is enabled in this change.** The decision, recorded so the follow-up does not re-litigate
it: **use the operator's own CronJob**, not the Paperclip approach.

Paperclip's data lives in Postgres, so its backups are CloudNativePG's (`task drill:restore`, the
barman-cloud plugin, an object store). OpenClaw has no database — its state is the PVC
(`openclaw.json`, the agent workspace, browser profiles). Routing that through CloudNativePG would
mean inventing a database that does not exist, and the operator's CronJob already writes exactly that
volume. Implementing it needs an object-store target and a restore drill that proves it, which is a
separate change with its own verification.

Until then the PVC is the only copy of the agent's workspace. Losing it loses conversation state and
any file an agent created; it does not lose credentials (1Password) or configuration (this repo).

## Operate

```bash
# Kind
kubectl --context kind-homelab-localdev -n openclaw get openclawinstance,pods,pvc
kubectl --context kind-homelab-localdev -n openclaw describe openclawinstance openclaw
task localdev:sync -- --only openclaw

# production, read-only (ADR-009)
kubectl --context homelab-readonly -n openclaw get openclawinstance openclaw -o wide
task prod:diff -- openclaw
```

The Instance's `status.phase` drives ArgoCD health through
`charts/bootstrap/files/health/openclaw.rocks_OpenClawInstance.lua`: `Running` is Healthy **only
while the `Ready` condition is not `False`** (the operator keeps the phase at `Running` through a
crash-looping container, which is exactly the "green in ArgoCD, degraded underneath" case),
`Degraded`/`Failed` are Degraded, `Suspended` is Suspended, everything else is Progressing.

## Verify

```bash
task verify:text                              # level 0
task test:health -- --only openclaw.rocks_OpenClawInstance
bun test scripts/openclaw-credentials_test.ts
task test:policy
task localdev:up && task verify:text LEVEL=2  # Kind

# after merge, read-only:
task verify:prod
```

## Follow-ups

- A tailnet-only endpoint with tag-scoped authorization, which is what "remote access" needs now
  that no route is rendered. Requires a Tailscale ACL change, so it is tracked on its own issue.
- Backups via the operator's CronJob, with an object-store target and a restore drill (decision
  above).
- LiteLLM as an OpenAI-compatible `models.providers` entry once #424 is deployed.
- Whether the two stacks should share one 1Password credential item, and whether OpenClaw should be
  exposed publicly behind oauth2-proxy — both currently defaults, see above.
