# e2e tests (Chainsaw)

End-to-end checks against the localdev Kind cluster after ArgoCD has synced every Application.
Each `tests/e2e/<name>/chainsaw-test.yaml` asserts that the ArgoCD Applications behind one
feature are `Healthy` + `Succeeded`, then exercises the feature from inside the cluster
(a curl Job through Envoy Gateway, a TCP connect, a CloudNativePG Cluster, a NetworkPolicy).

## Quick start

```bash
task localdev:up && task localdev:wait   # Kind + ArgoCD + sync, then wait for Healthy
task test:e2e                            # chainsaw test --config tests/e2e/.chainsaw.yaml tests/e2e
task test:e2e -- --test-dir tests/e2e/plex   # one test
task verify LEVEL=2                      # runs the same suite, reports e2e/<name> checks (JSON)
```

`homelab verify all --level 2` runs this suite with a JSON report and turns every test into an
`e2e/<name>` check next to the `argocd/<app>` and `dryrun/localdev/<chart>` checks.

## Layout

| Path | Purpose |
|------|---------|
| `.chainsaw.yaml` | Configuration: timeouts (`assert` 10m), 4 tests in parallel, no fail-fast, cleanup on |
| `argocd-apps/` | Root Applications asserted, then a script lists every Application and fails on any not Healthy/Succeeded; `APIService/v1beta1.metrics.k8s.io` (metrics-server) is Available |
| `cert-manager/` | The wildcard `Certificate/gateway-wildcard-tls` in `envoy-gateway-system` is Ready |
| `envoy-gateway/` | Controller `Deployment/envoy-gateway` Available, GatewayClasses Accepted and Gateways `envoy-internal`/`envoy-external` Programmed; a test backend and HTTPRoute on the `https` listener of `envoy-internal` answer 200, the `http` listener answers 301 to https |
| `istio-gateways/` | Gateways `istio-internal`/`istio-external` in `istio-ingress` Programmed; HTTPRoute `echo` Accepted by `istio-internal` and `envoy-internal`, and `echo.homelab.local` answers 200 through both |
| `grafana/`, `plex/`, `sonarr/`, `radarr/`, `prowlarr/`, `nzbget/`, `tautulli/`, `lazylibrarian/` | The app's HTTPRoute is Accepted with resolved refs, then HTTP through Envoy Gateway with its `<app>.homelab.local` host |
| `flaresolverr/` | HTTP straight to the ClusterIP Service (no route) |
| `mosquitto/` | TCP connect to `mosquitto.home-automation.svc.cluster.local:1883` |
| `cloudnative-pg/` | 1-instance `Cluster` on `local-path` reaches "Cluster in healthy state" |
| `paperclip/` | Applications `paperclip-operator`, `paperclip-dependencies`, `paperclip-database`, `paperclip` Healthy/Succeeded; the CNPG `Cluster/paperclip-postgres` and the `paperclip.inc` `Instance/paperclip` are ready; `curl-paperclip` Job reaches the app |
| `logging/` | Applications `clickhouse-operator`, `clickhouse`, `otel-collector-agent`, `otel-collector-cluster`, `otel-collector-gateway`, `kube-prometheus-stack` Healthy/Succeeded; a Job in `observability` queries ClickHouse as the read-only `grafana` user until `otel.otel_logs` has rows and a TTL, then sends an OTLP/HTTP span to the gateway until it is in `otel.otel_traces`; a second Job sends a syslog line to the gateway until `homelab_unifi_telemetry_records_total{source="syslog"}` appears on its port 8889 |
| `service-mesh/` | Applications `istio-base`, `istiod`, `istio-cni`, `ztunnel`, `istio-config`, `kiali` Healthy/Succeeded; `ztunnel` and `istio-cni-node` ready on every node; namespace `paperclip` enrolled with a Programmed `waypoint` Gateway; the Kiali HTTPRoute is Accepted and `curl-kiali` gets 200 from `servicemesh.homelab.local/healthz` |
| `cilium-netpol/` | default-deny NetworkPolicy blocks a curl Job, an allow policy lets one through |
| `agent-readonly/` | Application Healthy, token Secret populated; `kubectl auth can-i` as ServiceAccount `agent-access/agent-readonly` and as Group `homelab:agent-readonly`: reads yes, Secrets and every write no |

## How the HTTP tests reach an app

Each Gateway's `http` listener (Service port 80) only redirects to `https`, so the curl Jobs talk
TLS to the Envoy proxy Service on port 443 and pin the hostname with `--connect-to`:

```sh
curl -sk -L --connect-to "$HOST:443:$GATEWAY:443" --connect-to "$HOST:80:$GATEWAY:80" "https://$HOST$URL_PATH"
```

`GATEWAY` is `envoy-internal.envoy-gateway-system.svc.cluster.local` for routes on the internal
Gateway (grafana, the *arr apps, paperclip, kiali) and `envoy-external.envoy-gateway-system.svc.cluster.local`
for the external one (plex). `-k` accepts the localdev wildcard certificate. The shell loop retries 20
times, 6 s apart, until the HTTP code is in `EXPECT` (e.g. `"200 401"` for NZBGet's basic auth).

Before the curl, a `route-<app>` step asserts that an HTTPRoute in the app's namespace lists the
host and that its parent Gateway reports `Accepted` and `ResolvedRefs` `True`. It matches on the
hostname, not the route name, because upstream charts name their routes differently.

Jobs use `curlimages/curl` pinned to `images.curl` in `configuration/versions.yaml`, request
10m/32Mi and limit 100m/64Mi, `restartPolicy: Never`, `backoffLimit: 0`. Each step has a
`catch:` that dumps events, the Job's pod logs and the Application on failure.

## Adding a test for a new app

1. Find the Application name(s), namespace, route host and Gateway in
   `tests/snapshots/localdev/applications.yaml` (or `addons.yaml`). Pick an unauthenticated
   path that returns 200 (`/ping` for *arr apps, `/api/health` for Grafana, `/identity` for Plex).
2. Copy `tests/e2e/sonarr/chainsaw-test.yaml` to `tests/e2e/<app>/chainsaw-test.yaml`.
3. Change `metadata.name`, the Application names in the first step (`<app>` and `<app>-config`),
   the `route-<app>` step (namespace, host, Gateway), the Job name (`curl-<app>`), and the
   `HOST` / `GATEWAY` / `URL_PATH` / `EXPECT` env values.
4. Validate without a cluster:

   ```bash
   chainsaw lint test -f tests/e2e/<app>/chainsaw-test.yaml
   yamllint -c .yamllint tests/e2e
   ```

5. Run it: `task test:e2e -- --test-dir tests/e2e/<app>`.

`argocd-apps` needs no change: it discovers every Application at run time.

## Conventions

- Test names equal their directory name; one `chainsaw-test.yaml` per directory.
- Never assert on `status.sync.status`: with `argocd app sync --local` the Application is
  `OutOfSync` against Git by design; `health` + `operationState.phase` are the contract.
- Every container has resources and a pinned image tag; no secrets in tests.
- Resources created by a test live in the chainsaw namespace and are deleted on cleanup
  (`cleanup.skipDelete: false`; `--skip-delete` keeps them for debugging).
