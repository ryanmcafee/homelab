# litellm

[LiteLLM](https://www.litellm.ai/) is an OpenAI-compatible LLM gateway: one endpoint in front of
many providers, with virtual keys, per-key and per-team budgets, rate limits, spend tracking and an
admin dashboard. It runs through the upstream **componentized** chart
(`oci://ghcr.io/berriai/litellm/chart/litellm`, not the monolithic `litellm-helm`), which splits the
data plane, the management API and the dashboard into three Deployments plus a migrations Job. Its
database is a CloudNativePG `Cluster` on the existing `cloudnative-pg` addon, the same pattern as
[paperclip](paperclip.md) (ADR-015). Issue
[#424](https://github.com/ryanmcafee/homelab/issues/424).

Everything is gated on `litellm.enabled` and is never part of a PR preview (ADR-013): 1Password
items and a database cluster are cluster-level concerns.

## Applications

`charts/applications/templates/litellm.yaml` renders one namespace, one repository Secret and four
Applications. Three of the four are local charts in this repository; wave 13 is the upstream OCI
chart, configured entirely from the `litellm:` block of
`configuration/templates/helm-apps.tmpl`.

| Wave | Application | Source | What it owns |
|---|---|---|---|
| 10 | Namespace `litellm` | inline (PodSecurity `baseline`) | the target for everything below; all three components run non-root |
| 11 | `litellm-dependencies` | `charts/litellm-dependencies` | three `OnePasswordItem`s -> Secrets `litellm-master-key-secret`, `litellm-salt-key`, `litellm-api-keys`. Rendered **only** where a secret store exists (`SECRETS_PROVIDER=onepassword`); Kind seeds the same three Secrets from `localdev/fakes/secrets.yaml` |
| 12 | `litellm-database` | `charts/litellm-database` | CloudNativePG `Cluster` `litellm-db` (`bootstrap.initdb` database and owner `litellm`, image `images.cloudnative-pg-postgresql`, `STORAGE_CLASS_ISCSI_SSD` / 10Gi; `local-path` / 1Gi in Kind, PodMonitor on). CNPG generates Secret `litellm-db-app`, whose `username` and `password` keys are the proxy's only database credential |
| 13 | `litellm` | OCI chart `ghcr.io/berriai/litellm/chart/litellm` (`charts.litellm`), repository Secret `berriai-oci` | the release itself: `litellm-gateway` (4000), `litellm-backend` (4001), `litellm-ui` (3000), the `litellm-migrations` Job as an ArgoCD **PreSync** hook, and the gateway's `litellm-gateway-metrics` Service |
| 14 | `litellm-config` | `charts/litellm-config` | three `HTTPRoute`s publishing all three components on one hostname, plus the PostSync smoke Job `smoke-litellm` |

Waves 12 and 13 carry a sync `retry` (5 attempts, 5s doubling to 3m). Wave 12 needs the CNPG
`Cluster` CRD from the addon; wave 13's PreSync Job needs `litellm-db-app` and a database that has
finished bootstrapping. Without the retry a sync that lands a few seconds early fails outright.

### Why the componentized chart

| Component | Port | Role |
|---|---|---|
| `litellm-gateway` | 4000 | the `/v1/*` data plane, scaled for throughput |
| `litellm-backend` | 4001 | management API (`/key/*`, `/user/*`, `/team/*`, `/spend/*`) and the UI's API |
| `litellm-ui` | 3000 | the admin dashboard, a static Next.js export |
| `litellm-migrations` | - | `prisma migrate deploy`, once per sync |

Inference traffic never competes with dashboard traffic, and schema migrations run in a dedicated
Job instead of at proxy startup. All four images ship on one tag (`images.litellm`), which must move
together with `charts.litellm` -- the chart's `appVersion` is exactly that tag.

`redis` stays off: with one gateway replica nothing needs cross-pod state. Turning on more than one
gateway replica means turning Redis on too, because cross-pod rpm/tpm limits, spend tracking and the
pod lock manager all depend on it.

## Exposure

One hostname (`LITELLM_HOSTNAME`, `litellm.<your-domain>`) serves all three components on the
`https` listener of the internal Gateway. The upstream chart ships an `ingress:` block only, which
Envoy Gateway does not serve, so `charts/litellm-config` re-expresses the same routing table as
`HTTPRoute`s:

- `litellm-ui` -- an explicit path set (`/` and `/favicon.ico` Exact, `/_next`, `/ui`,
  `/litellm-asset-prefix` prefixes) plus a regular-expression match for root-level `*.txt`, the RSC
  payloads the dashboard's client router fetches. This is the only route carrying the external-dns
  hostname annotation, so one DNS record is published instead of three claims on the same name.
- `litellm-gateway` -- the data-plane prefixes, listed one by one. A broad `/v1` prefix would steal
  the management routes (`/v1/access_group`, `/v2/key/info`, `/v1/mcp/*`) that only the backend
  serves. Re-check this list on every chart bump against the upstream `templates/ingress.yaml`.
- `litellm-backend` -- the catch-all at `/`, which is why wave 13 sets the dashboard's `backendUrl`
  to the bare hostname.

`litellm-gateway-metrics` is deliberately **not** routable. That port serves `/metrics` with no auth
of its own; Prometheus scrapes it in-cluster through the ServiceMonitor.

Which Gateway the routes attach to is the whole exposure decision. `GATEWAY_INTERNAL` keeps the
proxy on the LAN and the tailnet. Pointing `litellm.route.gateway` at `GATEWAY_EXTERNAL` publishes
it to the internet, and then the UI route needs oauth2-proxy in front of it -- the dashboard's own
login is a master-key prompt, not an identity provider.

## Configuration keys

Everything environment-specific lives in `configuration/`; the child charts' committed values files
carry placeholders only, and derived values reach them through the parent Application's
`helm.valuesObject` (ADR-010).

| Key | File | Value |
|---|---|---|
| `LITELLM_HOSTNAME` | `configuration/schema/applications.schema.yaml` | `const: litellm.{{.DOMAIN}}` |
| `LITELLM_MASTER_KEY_1P_PATH` | `configuration/schema/secrets.schema.yaml` | `vaults/homelab/items/litellm-master-key` |
| `LITELLM_SALT_KEY_1P_PATH` | `secrets.schema.yaml` | `vaults/homelab/items/litellm-salt-key` |
| `LITELLM_API_KEYS_1P_PATH` | `secrets.schema.yaml` | `vaults/homelab/items/litellm-api-keys` |
| `STORAGE_CLASS_ISCSI_SSD` | `kubernetes.schema.yaml` | `democratic-csi-iscsi`; block storage, because PostgreSQL refuses a data directory whose files are not owned by uid 26, which is what every file on the NFS classes looks like (`mapall`) |
| `GATEWAY_INTERNAL`, `GATEWAY_NAMESPACE` | `kubernetes.schema.yaml` | which Gateway the three routes attach to |
| `SECRETS_PROVIDER` | `platform.schema.yaml` | `onepassword` renders wave 11; `none` skips it and you supply the three Secrets yourself |
| `charts.litellm`, `images.litellm`, `images.cloudnative-pg-postgresql`, `images.curl` | `configuration/versions.yaml` | Renovate-managed pins |

The model list, the component resource requests and limits, the CNPG sizing and
`proxy.serviceMonitor.enabled` also live in the `litellm:` block of `helm-apps.tmpl`, with separate
Kind and homelab branches. Chart-invariant wiring -- hook toggles, probes, Secret names,
`STORE_MODEL_IN_DB` -- lives in `charts/applications/templates/litellm.yaml` instead, because it is
a property of the chart rather than of an environment.

## Secrets

Three Secrets, one 1Password item each. **1Password field labels must equal the Secret keys**: the
salt key and the provider keys reach the pods through `envFrom`, which silently drops any key that
is not a valid environment-variable name.

| Secret (namespace `litellm`) | 1Password item | Fields | Read by |
|---|---|---|---|
| `litellm-master-key-secret` | `LITELLM_MASTER_KEY_1P_PATH` | `master-key` (an `sk-...` value) | the chart's `masterKey.secretName`/`secretKey`; the root credential for the management API and the dashboard login |
| `litellm-salt-key` | `LITELLM_SALT_KEY_1P_PATH` | `LITELLM_SALT_KEY` | `gateway.envSecrets` and `backend.envSecrets`. See [The salt key](#the-salt-key-set-once) -- generated once, never rotated |
| `litellm-api-keys` | `LITELLM_API_KEYS_1P_PATH` | one field per upstream provider credential (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) | `gateway.envSecrets`; the model list resolves them as `os.environ/<field>` |
| `litellm-db-app` | none (generated by CloudNativePG) | `username`, `password` | the chart's `database.writer.passwordSecret` |

No database credential is templated anywhere or stored in 1Password: CNPG generates it for the
`litellm` owner role and the chart reads that Secret directly.

Adding a provider means adding a field to the `litellm-api-keys` item and an entry to
`litellm.proxy.models` in `helm-apps.tmpl` that resolves it as `os.environ/<field>`. No key ever
reaches git. Kind seeds placeholders for all three Secrets and no request leaves the cluster.

With `SECRETS_PROVIDER=none` the `litellm-dependencies` Application is not rendered at all. The
three Secrets are then your responsibility -- create them in the `litellm` namespace with exactly
the names and keys in the table above before the first sync of wave 13, or the gateway and backend
pods stay in `CreateContainerConfigError` waiting for `envFrom`.

## The salt key: set once

> **`LITELLM_SALT_KEY` encrypts every provider credential LiteLLM stores in its database. Changing
> it makes all of them undecryptable. There is no re-encryption path and no way to recover the old
> plaintext from the database.**

Generate it once, before the first sync, and leave it alone forever. It lives in its own 1Password
item precisely so that rotating the master key -- which *is* safe to rotate -- cannot touch it.

What the salt key protects, and what it does not:

- **Protected**: credentials LiteLLM encrypted into the database itself. That means anything added
  through the Admin UI or the management API once `STORE_MODEL_IN_DB=True` is set -- models with an
  inline key, and stored provider credentials.
- **Not protected**: the entries in the committed model list. Those resolve as
  `os.environ/<field>` from the `litellm-api-keys` Secret on every request, so they survive a lost
  salt key untouched. This is why the floor of the model catalogue lives in `helm-apps.tmpl` rather
  than only in the database.

### If the salt key is lost or was changed

There is no decryption. Recovery is re-entry:

1. Put a newly generated value in the `litellm-salt-key` 1Password item (or accept the changed one).
2. Restart both consumers so they pick up the new Secret:

   ```bash
   kubectl -n litellm rollout restart deployment litellm-gateway litellm-backend
   ```

3. Re-enter **every** provider credential that was stored in the database, through the Admin UI or
   the management API. Anything you cannot re-enter from its source of truth is gone.
4. Models declared in `litellm.proxy.models` need nothing: they keep working throughout.

Virtual keys are a separate concern -- LiteLLM stores them hashed, not encrypted with the salt key
-- but treat that as unverified here and confirm against the chart's `appVersion` before you rely on
it during an incident. Re-check the blast radius on every chart bump.

## Migrations Job recovery

ArgoCD applies the manifests, so the Job runs as an ArgoCD PreSync hook, not a Helm hook
(`migrationJob.hooks.helm.enabled: false`, `hooks.argocd.enabled: true`). Consequences:

- It re-runs on **every** sync of the `litellm` Application, even when nothing rendered changed.
  `prisma migrate deploy` is idempotent, so a no-op run is normal and fast.
- `activeDeadlineSeconds: 1800` bounds the whole Job across its retries. A migration blocked on an
  unreachable database fails the sync after 30 minutes instead of hanging it forever.
- Its memory limit (1536Mi) is a requirement, not headroom: preparing the Prisma CLI toolchain is
  OOMKilled under 1Gi in either environment. If you see the Job's pod `OOMKilled`, the limit was
  lowered, not the migration.

**What a failure means for a sync.** PreSync runs before anything in the sync is applied, so a
failed migration stops the sync in its PreSync phase: waves 13 and 14 never apply, and the
Application reports the sync as `Failed`. Nothing is deleted -- the gateway, backend and UI pods
from the previous sync keep serving on the previous schema. A failed migration is an outage of
*deployment*, not of the data plane, unless the failure is itself the database being down.

Inspect it:

```bash
kubectl -n litellm get jobs
kubectl -n litellm logs job/litellm-migrations
kubectl -n litellm describe job litellm-migrations
```

If the logs point at the database rather than at a migration, check that first -- wave 12 is the
usual culprit:

```bash
kubectl -n litellm get cluster litellm-db
kubectl -n litellm get secret litellm-db-app
```

Re-run it by re-syncing the Application, which recreates the hook Job:

```bash
argocd app sync litellm
```

Delete the failed Job first if the hook's delete policy has left it behind:

```bash
kubectl -n litellm delete job litellm-migrations
```

## Virtual keys, budgets and spend

Callers never see a provider key. They get a **virtual key** minted against the master key, and the
proxy holds the real credentials. The master key is the root credential for all of this: it is the
dashboard login and the bearer token for the management API. Treat it as an admin password, not as a
client key -- give applications their own virtual keys.

Mint one against the management API on the backend (the catch-all route, so the bare hostname):

```bash
curl -s https://litellm.<your-domain>/key/generate \
  -H "Authorization: Bearer <master-key from litellm-master-key-secret>" \
  -H 'Content-Type: application/json' \
  -d '{"models": ["claude-sonnet-5"], "max_budget": 10, "budget_duration": "30d", "rpm_limit": 60}'
```

- `max_budget` + `budget_duration` cap spend per key and reset on that cadence; requests are
  rejected once the cap is hit.
- `rpm_limit` / `tpm_limit` cap rate. With one gateway replica these are per-pod and therefore
  exact; they only become approximate if the gateway scales out without Redis.
- Teams (`/team/new`) carry their own budget, so a team cap bounds every key under it.

The same operations are all in the Admin UI at `https://litellm.<your-domain>/ui`, which is the
easier path for anything interactive.

Callers then use the virtual key against the gateway, which is OpenAI-compatible:

```bash
curl -s https://litellm.<your-domain>/v1/chat/completions \
  -H "Authorization: Bearer <virtual key>" \
  -H 'Content-Type: application/json' \
  -d '{"model": "claude-sonnet-5", "messages": [{"role": "user", "content": "hello"}]}'
```

### Where spend shows up

Three places, in increasing order of durability:

1. **The Admin UI** -- the usage and spend views, broken down by key, team and model. The first
   place to look.
2. **The management API** -- `/spend/logs` and `/key/info` on the backend, per request and per key.
   This is the database's own record, so it survives pod restarts and is what the UI renders.
3. **Prometheus** -- the gateway's metrics sidecar exports `litellm_spend_metric_total` alongside
   `litellm_total_tokens_metric_total`, `litellm_proxy_total_requests_metric_total`,
   `litellm_proxy_failed_requests_metric_total` and the latency histograms. `gateway.metricsServer`
   and `gateway.serviceMonitor` are both on, so kube-prometheus-stack scrapes
   `litellm-gateway-metrics` without any further wiring.

Prometheus is the right source for alerting and dashboards; the database is the right source for
"what did this team actually spend last month", because counters reset when a pod restarts.

## Operate

- **First login**: open `https://litellm.<your-domain>` and sign in as user **`admin`** with the
  `master-key` field of the `litellm-master-key-secret` item as the password. The username is
  upstream's default: the release sets neither `UI_USERNAME` nor `UI_PASSWORD`, and with
  `UI_PASSWORD` unset the proxy accepts the master key as the password. Only the internal Gateway
  reaches the dashboard, so it is LAN/tailnet-only until `litellm.route.gateway` says otherwise.
- **Rotate the master key** (safe, unlike the salt key): change the field in 1Password, let the
  `OnePasswordItem` sync, then restart the consumers. Every virtual key minted against the old
  master key keeps working; only admin access changes.

  ```bash
  kubectl -n litellm rollout restart deployment litellm-gateway litellm-backend
  ```

- **Add a model**: for a permanent one, add the field to `litellm-api-keys` and the entry to
  `litellm.proxy.models` in `helm-apps.tmpl`, then let ArgoCD sync. Models added from the Admin UI
  live in the database instead (`STORE_MODEL_IN_DB=True`), which makes them fast to try and subject
  to [the salt key](#the-salt-key-set-once). The committed list is a floor, not the whole catalogue.
- **Bump the chart or the images**: Renovate opens a PR on `charts.litellm` and `images.litellm`.
  They must move together -- the chart's `appVersion` is exactly the image tag. `upgrade.yml` posts
  the rendered diff and the Kind loop proves the rollout. Never edit the chart files by hand.
- **Database**:

  ```bash
  kubectl -n litellm get cluster litellm-db
  kubectl cnpg status litellm-db          # if the kubectl-cnpg plugin is installed
  ```

  One instance, so there is no failover; `instances: 2` adds it (`primaryUpdateStrategy:
  unsupervised` switches the primary during upgrades). Production has no object store yet, so there
  is no CNPG `ScheduledBackup` -- the same interim position as `paperclip-postgres`, and the two
  clusters get one together.
- **Health**: the components serve `/health/liveliness` and `/health/readiness`. The PostSync smoke
  Job `smoke-litellm` curls the gateway's readiness endpoint through its ClusterIP Service, so a
  sync that leaves the data plane unable to answer fails instead of reporting Healthy.

## Verify

```bash
task verify:text                                   # level 0, no cluster
task localdev:up && task verify:text LEVEL=2       # Kind: Applications Healthy + e2e
task test:e2e -- --test-dir tests/e2e/litellm
# after merge, read-only:
task verify:prod && task prod:status
task prod:diff -- litellm
```

`tests/e2e/litellm/chainsaw-test.yaml` asserts the three Applications are Healthy with a Succeeded
sync, that all three `HTTPRoute`s are Accepted with resolved refs, and then curls one hostname four
ways to prove the path split: `/health/readiness` -> 200 from the gateway, `/` -> 200 from the UI,
`/index.txt` -> 200 (the RSC payload the regular-expression match rescues from the catch-all), and
`/key/info` -> 401 or 403 from the backend, which proves the management API is reached and rejects
the request for want of a key rather than being 404ed by a route that never gets there.

## Known limitations

- **One gateway replica, no Redis.** Scaling the gateway out requires enabling Redis first, or
  rpm/tpm limits and spend tracking become per-pod approximations.
- **No database backup.** No object store in production yet, so `litellm-db` has no
  `ScheduledBackup`. A lost volume loses the spend history and every virtual key.
- **No identity provider on the dashboard.** The UI authenticates with the master key. Publishing it
  on `GATEWAY_EXTERNAL` needs oauth2-proxy in front of the UI route first.
- **The gateway path list is a copy.** `charts/litellm-config/values.yaml` mirrors upstream's
  `$gatewayPrefixes`. A chart bump that adds a data-plane route will silently send it to the backend
  catch-all until that list is updated.
- **This runbook has not been executed against a live cluster.** Every resource name, port, path,
  Secret key and metric in it was read out of the manifests and rendered snapshots on this branch,
  and the e2e suite is what proves the routing end to end. The `kubectl`, `curl` and `argocd`
  commands are unverified against a running LiteLLM: agents have no cluster here and production is
  read-only. Report anything that does not behave as written as a bug against this file.
