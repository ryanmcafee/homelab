`paperclip.inc` CRDs + controller; `leaderElection.enabled: false` because chart 0.19.1 grants no RBAC on `coordination.k8s.io` leases while enabling `--leader-elect` (the manager never becomes leader, never reconciles, yet reports Ready) |# paperclip

[Paperclip](https://paperclip.ing/) is an open-source AI agent orchestration platform (org charts,
budgets, governance and coordination for teams of AI agents). It runs through the official
[paperclip-operator](https://github.com/paperclipinc/paperclip-operator); its database is a
CloudNativePG `Cluster` on the existing `cloudnative-pg` addon, not the operator's built-in
Postgres (ADR-015). Issue #260.

## Applications

All four are rendered by `charts/applications/templates/paperclip.yaml`, gated on
`paperclip.enabled`, and never part of a PR preview. They run in both environments (Kind included), except `paperclip-dependencies`, which only exists where a secret store does (`SECRETS_PROVIDER=onepassword`, like renovate and duckdns): Kind seeds its two Secrets from `localdev/fakes/secrets.yaml` instead.

| Wave | Application | Source | What it deploys |
|---|---|---|---|
| 10 | Namespaces `paperclip-operator`, `paperclip` | inline (PodSecurity `baseline`) | targets for the other Applications |
| 11 | `paperclip-operator` | OCI chart `ghcr.io/paperclipinc/charts/paperclip-operator` 0.19.1 (repository Secret `paperclipinc-oci`), `ServerSideApply=true`, CRDs kept | `paperclip.inc` CRDs + controller |
| 12 | `paperclip-dependencies` (secret store only) | `charts/paperclip-dependencies` | `OnePasswordItem`s `paperclip-auth`, `paperclip-api-keys` (the Application is not rendered without a secret store; Kind seeds both Secrets from `localdev/fakes/secrets.yaml`) |
| 13 | `paperclip-database` | `charts/paperclip-database` | CloudNativePG `Cluster` `paperclip-postgres`: 1 instance, image `ghcr.io/cloudnative-pg/postgresql:17.11` (`images.cloudnative-pg-postgresql`), `STORAGE_CLASS_ISCSI_SSD` (iSCSI block on the SSD pool; NFS classes fail initdb with "wrong ownership", bugs.md 2026-09-15) / 10Gi (local-path / 1Gi in Kind), PodMonitor on. CNPG generates Secret `paperclip-postgres-app`; its `uri` key is the app's `DATABASE_URL` |
| 14 | `paperclip` | `charts/paperclip` | `paperclip.inc/v1alpha1` `Instance` `paperclip` + PostSync smoke Job `smoke-paperclip` |

The `Instance`: image `ghcr.io/paperclipai/paperclip` at `images.paperclip` (2026.916.1);
`database.mode: external` with `externalURLSecretRef {paperclip-postgres-app, uri}`;
`deployment.mode: authenticated`, `exposure: private` (the instance sits behind the internal Traefik only; `public` cannot be onboarded by operator 0.19.1 with app 2026.831+, see the values comment), `publicURL: https://paperclip.<domain>`;
admin bootstrapped once from `PAPERCLIP_ADMIN_EMAIL` + `ADMIN_PASSWORD`, `disableSignUp: false` for now (the bootstrap Job signs the admin up through the same API, see the values comment and bugs.md 2026-09-15; the instance has reported `status.bootstrap` since 2026-09-15, so flipping it back to `true` is an open follow-up);
Ingress class `internal` with cert-manager `letsencrypt` and external-dns, TLS Secret `paperclip-tls`;
Service `paperclip` port 3100, health path `/api/health`; the operator's default NetworkPolicy stays
enabled; `security.seLinuxRelabel: false` (the operator's default privileged relabel init container is rejected by the namespace's PodSecurity baseline, and chcon has no purpose on Talos or NFS); Instance metrics off (the OTEL preload and collector do not exist here); persistence 10Gi
on `STORAGE_CLASS_ISCSI_SSD` (block storage: the server refuses a secrets directory not owned by uid 1000, which rules out the NFS classes; the volume is `/paperclip`, the container's `HOME`, so the bundled `claude`
and `codex` CLIs keep their logins in `/paperclip/.claude` and `/paperclip/.codex` across restarts);
`adapters.extraSecretEnv` (default `[CLAUDE_CODE_OAUTH_TOKEN]`) exposes keys of
`paperclip-api-keys` as optional environment variables, and `adapters.apiKeys.anthropic.enabled` /
`adapters.apiKeys.openai.enabled` (both default `false`) add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` one at a time, see [Agent credentials](#agent-credentials-subscriptions-or-api-keys).
The smoke Job curls `http://paperclip.paperclip.svc.cluster.local:3100/api/health`.

## Node pin

The operator's one-shot admin bootstrap Job mounts the same `ReadWriteOnce` data volume as the
server although it only calls the HTTP API, and operator 0.19.1 copies only
`availability.nodeSelector` and `tolerations` (not affinity) to that Job. On iSCSI the Job pod
therefore has to run on the server's node or it sits in `ContainerCreating` with
`Multi-Attach error`. Homelab pins both to one labelled node (`availability.nodeSelector`
from `helm-apps.tmpl`); Kind sets nothing. Exactly one node carries the label:

```bash
kubectl label node <node> paperclip.homelab/pin=true
# to move: label the new node, remove the label from the old one, then
kubectl -n paperclip rollout restart statefulset paperclip
```

The pin goes away once upstream drops the volume from the Job or gives it pod affinity.

## Configuration keys

| Key | File | Value |
|---|---|---|
| `PAPERCLIP_HOSTNAME` | `configuration/schema/applications.schema.yaml` | `const: paperclip.{{.DOMAIN}}` |
| `PAPERCLIP_ADMIN_EMAIL` | `applications.schema.yaml` (required) | gitignored `homelab.yaml` **and** the `homelab-environment-config` 1Password document; `admin@homelab.local` in localdev |
| `PAPERCLIP_AUTH_1P_PATH` | `secrets.schema.yaml` + `defaults.yaml` | `vaults/homelab/items/paperclip-auth` |
| `PAPERCLIP_API_KEYS_1P_PATH` | `secrets.schema.yaml` + `defaults.yaml` | `vaults/homelab/items/paperclip-api-keys` |
| `STORAGE_CLASS_ISCSI_SSD` | `kubernetes.schema.yaml` + `defaults.yaml` | `democratic-csi-iscsi` (block storage for the database; `local-path` in Kind) |
| `charts.paperclip-operator`, `images.paperclip`, `images.cloudnative-pg-postgresql` | `configuration/versions.yaml` | Renovate-managed pins |

## Secrets

1Password field names must equal the Secret keys the operator reads.

| Secret (namespace `paperclip`) | 1Password item | Fields | Consumed by |
|---|---|---|---|
| `paperclip-auth` | `op://homelab/paperclip-auth` | `BETTER_AUTH_SECRET`, `ADMIN_PASSWORD` | `spec.auth.secretRef`, `spec.auth.adminUser.passwordSecretRef` |
| `paperclip-api-keys` | `op://homelab/paperclip-api-keys` | `CLAUDE_CODE_OAUTH_TOKEN` (subscription, the default); `ANTHROPIC_API_KEY` only with `adapters.apiKeys.anthropic.enabled`, `OPENAI_API_KEY` only with `adapters.apiKeys.openai.enabled` | the chart's `spec.env` (one optional `secretKeyRef` per enabled key); never the operator's `spec.adapters.apiKeysSecretRef` |
| `paperclip-postgres-app` | none (generated by CloudNativePG) | `uri` and friends | `spec.database.externalURLSecretRef` |

## Agent credentials: API keys or subscriptions

The image bundles the Claude Code and Codex CLIs (`@anthropic-ai/claude-code`, `@openai/codex`),
runs as uid 1000 with `HOME=/paperclip`, and `/paperclip` is the persistent data volume (PVC
`paperclip-data`), so `~/.claude` and `~/.codex` survive restarts. The chart's
`adapters.extraSecretEnv` (default `[CLAUDE_CODE_OAUTH_TOKEN]`) turns each listed key of
`paperclip-api-keys` into an optional `spec.env` entry for the server and the onboarding init
container, so a missing key is simply unset. API keys go the same way, one toggle per provider:
`adapters.apiKeys.anthropic.enabled` adds `ANTHROPIC_API_KEY`, `adapters.apiKeys.openai.enabled`
adds `OPENAI_API_KEY`, and a disabled key is never declared. The chart does not use the operator's
`spec.adapters.apiKeysSecretRef`: operator 0.19.1 (`internal/resources/statefulset.go`) turns that
one reference into both variables at once, so it cannot expose one provider's key without the
other's. Both toggles default to `false`: subscriptions are the default, and with them neither
API-key variable exists in the pod. The 1Password item carries whichever you use.

Since app 2026.916.0 this environment-variable path is the *legacy* one: upstream moved provider
credentials into the app's Connections as managed accounts with their own grants, and the UI steers
new agents there. Existing agents keep their current authentication until they explicitly adopt a
managed connection, so nothing here has to change. Two consequences of the same release: a `plain`
value set in an agent's adapter env is redacted in every API response after you save it, so read it
back from 1Password rather than from the API, and the removed "cheap model profile" second execution
mode means recovery runs now use the same model as normal work.

Since app 2026.916.0 this environment-variable path is the *legacy* one: provider credentials are
meant to live in the app's Connections as managed accounts with their own grants. Existing agents
keep their current authentication until they explicitly adopt a managed connection, so nothing here
has to change — but the UI now steers new agents towards Connections. Two consequences of the same
release: a `plain` value set in an agent's adapter env (below) is redacted in every API response
after you save it, so read it back from 1Password rather than from the API, and the removed "cheap
model profile" second execution mode means recovery runs now use the same model as normal work.

### API keys (API billing)

Enable only the provider you pay per token, in `charts/paperclip/values.yaml`; each toggle is
independent and enabling one never adds the other's variable:

- **Anthropic**: `adapters.apiKeys.anthropic.enabled: true` and put `ANTHROPIC_API_KEY` in the
  1Password item. The `claude_local` adapter reads it from the server environment; Claude Code
  ranks it above `CLAUDE_CODE_OAUTH_TOKEN`, so an API key in the pod wins over a subscription token.
- **OpenAI**: `adapters.apiKeys.openai.enabled: true`, put `OPENAI_API_KEY` in the 1Password item,
  then seed Codex once inside the pod. The
  `codex_local` adapter pins every agent to its own `CODEX_HOME` with `OPENAI_API_KEY=""` so an
  agent can never spend against the host environment: Codex reads the key from `auth.json`, never
  from the process environment.

  ```bash
  kubectl -n paperclip exec paperclip-0 -- sh -c 'printenv OPENAI_API_KEY | codex login --with-api-key'
  ```

  This writes `/paperclip/.codex/auth.json` on the PVC, which Paperclip symlinks into each agent's
  managed home. To give a single agent its own key instead, set `OPENAI_API_KEY` in that agent's
  adapter env in the Paperclip UI; Paperclip then writes a per-agent `auth.json` with only that key.

### Subscriptions (Claude Pro/Max/Team, ChatGPT)

**Claude (`claude_local`)**: a subscription OAuth token. On a workstation logged into the
subscribed account:

```bash
claude setup-token      # opens the browser, prints a one-year token, saves nothing
```

Store the token as field `CLAUDE_CODE_OAUTH_TOKEN` of the 1Password item and keep
`adapters.apiKeys.anthropic.enabled` at `false`, so no `ANTHROPIC_API_KEY` reaches the pod (an API
key would take precedence and bill the API). Renew the
token yearly. Alternative: log in inside the pod, which writes `/paperclip/.claude/.credentials.json`
on the PVC; such logins expire and are renewed with `/login`, and `/status` shows which credential
is active. Paperclip's "Test Environment" button on the agent reports the auth mode it detected.

```bash
kubectl -n paperclip exec -it paperclip-0 -- claude   # choose the Claude account login, paste the code the browser shows
```

**Codex (`codex_local`)**: a ChatGPT login lives in `~/.codex/auth.json`, Codex refreshes it
automatically and Paperclip symlinks the file into each agent's managed `CODEX_HOME`. Seed it once
inside the pod (device-code login must be enabled in the ChatGPT account's security settings; the
CLI prints a code to enter in the browser):

```bash
kubectl -n paperclip exec -it paperclip-0 -- codex login --device-auth
```

Or log in on a workstation and copy the file:

```bash
kubectl -n paperclip exec paperclip-0 -- mkdir -p /paperclip/.codex
kubectl -n paperclip cp ~/.codex/auth.json paperclip-0:/paperclip/.codex/auth.json
```

With `adapters.apiKeys.openai.enabled: false` no `OPENAI_API_KEY` reaches the pod, so Codex bills
the subscription; a per-agent key set in the Paperclip UI still overrides the host login. The operator's NetworkPolicy already allows egress on TCP 443, which the
logins and the models need. `auth.json` is a credential; never commit or share it.

**Caveat**: Anthropic's April 2026 policy excludes third-party harnesses that use subscription OAuth
from subscription quota. Paperclip's `claude_local` adapter runs the official `claude` CLI as a
subprocess, which the Paperclip community reads as covered
([paperclipai/paperclip#2698](https://github.com/paperclipai/paperclip/discussions/2698)), and the
`setup-token` documentation says the token "authenticates with your Claude subscription". Anthropic
may change this: if subscription requests start failing or drawing extra-usage credits, switch the
item to `ANTHROPIC_API_KEY`.

Kind seeds all three keys as placeholders in `localdev/fakes/secrets.yaml`; with both toggles at
their default only `CLAUDE_CODE_OAUTH_TOKEN` is wired, and flipping either one in Kind exercises
that provider's wiring alone. No agent runs there.

## Operate

- **First login**: open `https://paperclip.<domain>` and sign in with `PAPERCLIP_ADMIN_EMAIL` and
  the `ADMIN_PASSWORD` field of `paperclip-auth`. Self-service sign-up is still **enabled**
  (`auth.disableSignUp: false`, the bootstrap workaround); only the internal Traefik reaches the
  instance, so the exposure is LAN/tailnet-only until the follow-up flips it back.
- **Rotate `BETTER_AUTH_SECRET`**: edit the field in the 1Password item; the operator's
  `OnePasswordItem` sync updates the Secret. Then restart the workload, which invalidates every
  session:

  ```bash
  kubectl -n paperclip rollout restart statefulset paperclip
  ```

- **Reset the admin password**: the bootstrap Job runs once, so for an existing admin change the
  password in the app UI. The `ADMIN_PASSWORD` value in 1Password only matters before the first
  bootstrap or for a fresh database.
- **Bump the image**: Renovate opens a PR on `images.paperclip`; `upgrade.yml` posts the rendered
  diff and the Kind loop proves the rollout. Never edit the chart files by hand.
- **Database (CloudNativePG)**:

  ```bash
  kubectl -n paperclip get cluster paperclip-postgres
  kubectl cnpg status paperclip-postgres        # if the kubectl-cnpg plugin is installed
  ```

  Failover is automatic once `instances: 2`. Production has no object store yet, so there is no
  CNPG `ScheduledBackup`; Paperclip's app-native backups (`spec.backup.appNative`, on by default,
  PVC-backed) are the interim safety net.

## Verify

Level 0 uses the vendored `tests/schemas/paperclip.inc/instance_v1alpha1.json`, the registries
`tests/gitops/{crd-providers,huge-crd-charts,known-secrets}.yaml`, the e2e test
`tests/e2e/paperclip` and the health Lua `charts/bootstrap/files/health/paperclip.inc_Instance.lua`
(`Running` = Healthy, `Failed`/`Error` = Degraded, anything else Progressing).

```bash
task verify:text                                   # level 0
task localdev:up && task verify:text LEVEL=2       # Kind: Healthy + Succeeded, e2e
task test:e2e -- --test-dir tests/e2e/paperclip
# after merge, read-only:
task verify:prod && task prod:status
task prod:diff -- paperclip
```

## Follow-ups

- Flip `auth.disableSignUp` back to `true` (bugs.md 2026-09-15): the instance has reported
  `status.bootstrap` since 2026-09-15, so the Job short-circuits and the workaround is no longer
  needed. Verify the operator does not re-run the bootstrap Job on the changed spec hash first
- CNPG `ScheduledBackup` + `ObjectStore` for `paperclip-postgres` once an S3-compatible target exists in production
- `spec.adapters.cloudSandbox` (in-cluster agent sandboxes) and inference proxy
- Google OAuth login (`spec.auth.google`) reusing the `google-oauth` 1Password item
- Scale CNPG to 2 instances and the Instance to `workload: Deployment` + object storage for HA
- Instance metrics once an OTEL collector exists in the cluster
