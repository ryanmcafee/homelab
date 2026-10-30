# LiteLLM: metrics, dashboard and alerts

The LiteLLM proxy (`litellm` namespace, [issue #424](https://github.com/ryanmcafee/homelab/issues/424))
serves three surfaces: the **gateway** on `:4000` (`/v1/*`, the only path a caller sees), the
**backend** on `:4001` (management API) and the **ui** on `:3000`. Its database is the
CloudNativePG Cluster `litellm-db`.

Only the gateway has alerts. A backend or UI outage costs the admin dashboard, which nobody's
inference request goes through; the gateway is the user-visible path, so that is what pages
(symptom-based alerting).

## Where the numbers come from

| Source | Series | How it is wired |
|---|---|---|
| gateway metrics sidecar | `litellm_*` | `gateway.metricsServer` runs `python -m litellm.proxy.prometheus_metrics_server` as a second container that aggregates the uvicorn workers' `PROMETHEUS_MULTIPROC_DIR` over a shared `emptyDir`, so a scrape never lands on an inference worker. `gateway.serviceMonitor` points Prometheus at the `litellm-gateway-metrics` ClusterIP Service, path `/metrics/`, every 15 s. |
| kube-state-metrics | `kube_deployment_status_replicas_available`, `kube_job_failed` | the monitoring stack's default collectors |
| CloudNativePG | `cnpg_collector_up` | `monitoring.enablePodMonitor` on the `litellm-db` Cluster |

Three details decide what these numbers do and do not cover:

- **The prometheus callback has to be on.** The sidecar only aggregates what the workers write,
  and the workers write nothing until `litellm_settings.callbacks` contains `prometheus`. That is
  set in `charts/applications/templates/litellm.yaml`, not in `configuration/`: it is a property
  of running the proxy here, not an environment fact. Without it the scrape succeeds and returns
  an empty registry, which looks healthy and tells you nothing.
- **Labels are trimmed.** LiteLLM's default label set includes `client_ip`, `user_agent`,
  `end_user`, `user_email` and `hashed_api_key`, all per-request or per-caller. On a homelab
  Prometheus that multiplies every series by the number of callers, so
  `litellm_settings.prometheus_exclude_labels` drops them. `requested_model`, `model`, `team`,
  `api_key_alias`, `status_code` and `api_provider` stay, and those are what the dashboard and the
  alerts group by. Adding a label back is a deliberate cardinality decision.
- **Authentication failures are not counted.** LiteLLM drops every Prometheus metric for a request
  that fails with a 401, so no `litellm_*` series will ever show one. Nothing here measures auth,
  and the error rate cannot see it. See `LiteLLMGatewayErrorRateHigh` below.

**The metrics port has no authentication.** That is why it is a separate Service: the gateway's
own `:4000` serves `/metrics/` behind virtual-key auth, while the sidecar's port serves it to
anyone who can reach the pod. Both the `litellm-gateway-metrics` Service and the gateway Service
are `ClusterIP`, the chart's own Ingress is off, and no HTTPRoute in this repo names any LiteLLM
Service. Whatever publishes the proxy must keep routing to `litellm-ui` and the backend, and must
never attach a route to the metrics port.

## The dashboard

**"LiteLLM gateway"** (`charts/applications/dashboards/litellm-gateway.json`, uid
`litellm-gateway`), shipped as a ConfigMap in the `litellm` namespace and picked up by the
kube-prometheus-stack Grafana sidecar.

The top row answers "is anyone affected right now?" in four numbers: pods scraped, requests/s,
error rate, spend in the last 24 h. Below it, request and failure rate by model, end-to-end
latency percentiles next to provider-only latency (a gap between them is proxy overhead, not a
slow provider), tokens/s and spend per hour.

Caveats worth knowing before you read a number off it:

- `litellm_request_total_latency_metric` covers proxy entry to response, so a streaming response
  is as slow as the stream. Long tails there are usually not a fault.
- Tokens and spend are counted when a response completes, so both trail long streams.
- Spend is LiteLLM's own cost map applied to the request, not the provider's invoice.

## The alerts

Group `homelab-litellm` in `charts/addons/templates/kube-prometheus-stack.yaml`, gated on
`litellm.enabled` so a cluster without the proxy carries no rules that can only go absent.
Severities route as in [alerting.md](./alerting.md). Unit tests:
`tests/alerts/litellm.test.yaml`, run by `task test:alerts`.

| Alert | Severity | Fires when | First action |
|---|---|---|---|
| `LiteLLMGatewayDown` | critical | no `litellm-gateway` replica available for 5 m | `kubectl -n litellm describe deploy litellm-gateway` and the pod events |
| `LiteLLMGatewayErrorRateHigh` | warning | over 10 % of accepted requests failed for 10 m, over at least ~6 requests in the window | dashboard, "Failed requests by model" |
| `LiteLLMGatewayMetricsUnavailable` | warning | the metrics scrape is down or has no target for 15 m | `kubectl -n litellm logs deploy/litellm-gateway -c metrics` |
| `LiteLLMMigrationsJobFailed` | warning | the migrations Job reported the `Failed` condition in the last 30 m | `kubectl -n litellm logs job/litellm-migrations` while it still exists |
| `LiteLLMDatabaseNotReady` | critical | no `litellm-db` instance has been scraped for 15 m | `kubectl -n litellm get cluster litellm-db` |

### LiteLLMGatewayDown

Every `/v1` request fails. The pod events name the cause: a missing `litellm-master-key-secret`
or `litellm-api-keys` Secret keeps the pod `Pending` on its `envFrom`, an unreachable
`litellm-db-rw` crash-loops it on the readiness probe. If the Secrets are the problem, the
1Password items behind them are `LITELLM_*_1P_PATH` in `configuration/environments/homelab.yaml`;
in Kind they come from `localdev/fakes/secrets.yaml`.

Rollback: `task prod:diff -- litellm` shows what the last sync changed. The gateway, backend and
UI share one image tag (`configuration/versions.yaml` `images.litellm`), so a bad tag is one
revert away — but check `LiteLLMMigrationsJobFailed` first, because a schema that has already
migrated forward does not roll back with the image.

### LiteLLMGatewayErrorRateHigh

The SLI is `litellm_proxy_failed_requests_metric_total / litellm_proxy_total_requests_metric_total`
over 10 m. The volume floor (0.01 req/s, about six requests in the window) exists because a
homelab gateway is idle most of the day and one failed request out of one is not an incident.

Split by model on the dashboard first. One model failing while the others are fine is a provider
outage or a revoked key for that provider; all models failing together is the proxy, usually the
database or an expired master key. `status_code` on
`litellm_proxy_total_requests_metric_total` separates a 429 (rate limit) from a 5xx (provider).

This alert is blind in two ways, both of which look identical to "no problem":

- Whenever `LiteLLMGatewayMetricsUnavailable` fires. Treat the pair together.
- For **any request that fails with a 401**, at either hop. LiteLLM excludes authentication
  failures from every Prometheus metric on purpose, so a caller with a bad virtual key and a
  provider rejecting our credentials both leave the failed *and* total counters untouched -- the
  ratio stays flat and healthy while no request succeeds. If callers report 401s and this graph is
  quiet, that is consistent, not contradictory: read the gateway pod logs, and check
  `LiteLLMGatewayDown` and the provider key in `litellm-api-keys` rather than the error rate.
  Source: `PrometheusLogger._is_invalid_api_key_request` returns early for `status_code == 401`.

### LiteLLMGatewayMetricsUnavailable

Traffic may be perfectly fine; what is broken is the ability to see it. Two shapes:

- the `up` series exists and is 0 — the `metrics` container is down or wedged. Its readiness
  probe is a TCP check, so a process that listens but cannot read the multiproc dir stays Ready.
- there is no `up` series at all — the ServiceMonitor is gone or no longer selects
  `litellm-gateway-metrics`. `kubectl -n litellm get servicemonitor,svc` and compare the selector
  with the Service labels.

### LiteLLMMigrationsJobFailed

`prisma migrate deploy` runs as an ArgoCD **PreSync** hook, so it re-runs on every sync and a
failure fails the whole sync: the Application stays on the previous schema and the new manifests
never apply. The Job's `activeDeadlineSeconds` (1800) bounds it across all four retries, so a
migration blocked on the database fails instead of hanging the sync forever.

The Job is deleted 120 s after it finishes (`ttlSecondsAfterFinished`), which is why the rule
reads `max_over_time(...[30m])` instead of the instantaneous value — otherwise the alert would
fire and resolve before a notification was worth reading. Get the logs quickly, or read the
failure from the ArgoCD Application's sync result. Warning rather than critical because callers
are still served by the running gateway; if they are not, `LiteLLMGatewayDown` is firing too.

### LiteLLMDatabaseNotReady

`absent(cnpg_collector_up{namespace="litellm", cluster="litellm-db"})`: no instance of the Cluster
is being scraped at all, which is a Cluster that never finished bootstrapping — a stuck `initdb`,
an unbound volume, a missing storage class. The generic `HomelabPostgresClusterDown` cannot see
this, because it needs a `cnpg_collector_up` series to *be* 0 and there is none; the two rules
split the failure between them and `tests/alerts/litellm.test.yaml` asserts that split.

`kubectl -n litellm get cluster litellm-db` shows the phase and
`kubectl -n litellm describe cluster litellm-db` the reason. There is no ScheduledBackup yet, so
there is nothing to restore from: fix the Cluster in place. The migrations Job and the gateway
both block on it, so expect `LiteLLMGatewayDown` alongside on a fresh install.

## Bypassing an alert

Silences are time-bounded and the reason goes in the issue; see
[alerting.md](./alerting.md#silence-inspect-change). Do not turn a rule off to make a dashboard
green — set `litellm.enabled` to false in `configuration/` if the proxy itself is going away.

## Related

- [alerting.md](./alerting.md) — routes, receivers, how to add a rule
- [verification.md](./verification.md) — the level 0/1/2 contract these changes pass through
- [../applications.md](../applications.md) — the Application inventory
