# Alerting: Alertmanager routes, receivers and rules

Prometheus alerts reach you through Alertmanager (kube-prometheus-stack, wave 9) as Pushover
notifications: critical at high priority, warning at low priority, everything else is dropped.
The Pushover credentials live in one 1Password item; nothing secret is committed.

| Severity | Receiver | Pushover priority | Why |
|---|---|---|---|
| `critical` | `pushover-critical` | 1 (high) while firing, 0 when resolved | wakes you up |
| `warning` | `pushover-warning` | -1 (low, no sound) | look during the day |
| `info`, `Watchdog`, `InfoInhibitor` | `null` | — | the chart's heartbeat and inhibitor plumbing; never a page |

A `critical` alert inhibits the `warning`/`info` alert of the same `alertname` in the same
namespace. Groups form on `alertname, namespace, severity`; a group waits 30 s, updates every
5 m and repeats every 4 h. Resolved notifications are sent for both severities.

Where it is defined: `charts/addons/templates/kube-prometheus-stack.yaml` (`alertmanager.config`,
`alertmanagerSpec.secrets`, `additionalPrometheusRulesMap`), values from
`configuration/templates/helm-addons.tmpl` (`kube-prometheus-stack.alertmanager.notifications`),
the Secret from `charts/prometheus-config/templates/alertmanager-notifications.yaml`.

## The 1Password item

`ALERTMANAGER_1P_PATH` (default `vaults/homelab/items/alertmanager-notifications`) names one
item with two fields. The 1Password operator turns it into Secret `alertmanager-notifications`
in `monitoring`; Alertmanager mounts it at `/etc/alertmanager/secrets/alertmanager-notifications/`
and both receivers read the `*_file` paths there, so the values never appear in an Application
spec.

| Field | Value | Where to get it |
|---|---|---|
| `pushover_token` | Application API token | pushover.net: *Create an Application/API Token* |
| `pushover_user_key` | Your user (or group) key | pushover.net dashboard |

Change the item path in `configuration/environments/homelab.yaml` if you name the item
differently.

Until the item exists the `alertmanager-notifications` OnePasswordItem is Degraded and the
Alertmanager pod stays Pending (its Secret volume is missing); creating the item resolves
both without a sync. Without a secret store (`SECRETS_PROVIDER=none`, Kind) Alertmanager is
off entirely, so localdev renders nothing of this.

## Test delivery

Push a synthetic alert straight into Alertmanager from inside the cluster; it is routed like
any other. Use `task prod:kubeconfig` first if you have no admin context (the read-only
`homelab-readonly` context cannot exec).

```bash
POD=alertmanager-kube-prometheus-stack-alertmanager-0
# warning -> Pushover, low priority (silent)
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 \
  alert add DeliveryTest severity=warning namespace=monitoring \
  --annotation='summary="Pushover low-priority delivery test"' --end="$(date -u -v+2M +%Y-%m-%dT%H:%M:%SZ)"
# critical -> Pushover, high priority
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 \
  alert add DeliveryTest severity=critical namespace=monitoring \
  --annotation='summary="Pushover high-priority delivery test"' --end="$(date -u -v+2M +%Y-%m-%dT%H:%M:%SZ)"
# what Alertmanager did with it
kubectl -n monitoring logs "$POD" -c alertmanager | rg -i "notify|pushover" | tail
```

Both end after two minutes and send a resolved notification. The annotation value is
double-quoted inside the single quotes because Alertmanager's UTF-8 matcher parser rejects
unquoted values with spaces (the classic parser still accepts them, with a warning).
Verified end to end on 2026-09-19: both notifications arrived on Pushover. The Alertmanager UI is not
exposed; port-forward when you need it: `kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093`.

## Silence, inspect, change

```bash
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 alert          # firing now
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 \
  silence add alertname=HomelabNodeNotReady node=worker-1 --duration=2h --comment="planned reboot"
kubectl -n monitoring exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 silence
```

Agents read what is firing the same way through the read-only identity, which may `exec` and
port-forward but not change API objects (`docs/runbooks/readonly-access.md`). Pass the kubeconfig
explicitly, because `.envrc` pins `KUBECONFIG` to `~/.kube/config`:

```bash
kubectl --kubeconfig ~/.kube/homelab-readonly.yaml --context homelab-readonly -n monitoring \
  exec "$POD" -c alertmanager -- amtool --alertmanager.url=http://localhost:9093 alert
```

To change routing or receivers edit `alertmanager.config` in the Application template and
prove the result before pushing:

```bash
task chart:template:addons | yq -r 'select(.kind=="Application" and .metadata.name=="kube-prometheus-stack") | .spec.source.helm.values' | yq -r '.alertmanager.config' > /tmp/am.yaml
amtool check-config /tmp/am.yaml        # go install github.com/prometheus/alertmanager/cmd/amtool@latest
```

Alertmanager's own `{{ }}` templating inside that file is written as ``{{`{{ ... }}`}}`` so Helm
leaves it alone; the snapshot in `tests/snapshots/homelab/addons.yaml` shows the final text.

## Rules

The chart's `defaultRules` stay on (node, kubelet, volumes, targets, etcd once scraped) with one
exception: `CPUThrottlingHigh` is disabled in `defaultRules.disabled` and re-stated below with a
floor under its denominator. The chart's version divides throttled CFS periods by the periods a
container ran in *at all*, so a container that is 99 % idle reads as badly throttled off a handful
of samples; that is how 16 alerts stood on democratic-csi for three months while the drivers used
12m of CPU. Homelab rules live in `additionalPrometheusRulesMap`:

| Group | Alert | Severity | Fires when |
|---|---|---|---|
| homelab-control-plane | `KubeAPIServerErrorsHigh` | critical | apiserver 5xx > 0.5/s for 2 m |
| homelab-control-plane | `NodeDiskWriteLatencyHigh` | warning | sda write latency > 50 ms for 10 m |
| homelab-control-plane | `EtcdMetricsAbsent` | warning | no `kube-etcd` target up for 15 m |
| homelab-infrastructure | `HomelabNodeNotReady` | critical | a node NotReady for 5 m |
| homelab-infrastructure | `HomelabNodeUnderPressure` | warning | Memory/Disk/PID pressure for 10 m |
| homelab-infrastructure | `HomelabEtcdQuorumAtRisk` | critical | fewer than 2 etcd members up for 5 m |
| homelab-infrastructure | `HomelabPostgresClusterDown` | critical | a CloudNativePG cluster reports no PostgreSQL up for 5 m |
| homelab-infrastructure | `HomelabArgoCDApplicationDegraded` | warning | an Application is Degraded/Missing/Unknown for 15 m |
| homelab-infrastructure | `HomelabCertificateExpiringSoon` | warning | a cert-manager Certificate expires in under 14 days for 1 h |
| homelab-infrastructure | `HomelabClusterDNSFailing` | critical | CoreDNS answers SERVFAIL for more than 10 % of queries for 15 m ([cluster-dns.md](./cluster-dns.md)) |
| homelab-infrastructure | `HomelabClusterDNSUpstreamDown` | critical | CoreDNS has no healthy upstream resolver for 10 m ([cluster-dns.md](./cluster-dns.md)) |
| homelab-infrastructure | `CPUThrottlingHigh` | info | more than 25 % of CFS periods throttled for 15 m, **and** the container ran in more than 300 of the 3000 periods in the window |
| homelab-ingress | `HomelabTraefikDown` | critical | no pod of `traefik-internal` or `traefik-external` answers the scrape for 5 m |
| homelab-ingress | `HomelabTraefikBackendErrors` | warning | more than 5 % of a backend's requests are 5xx for 10 m (at least 0.1 req/s) |
| homelab-ingress | `HomelabTraefikBackendSlow` | warning | a backend's p95 response time is above 5 s for 10 m |
| homelab-logging | `HomelabLogExportFailing` | warning | a collector fails to export log records to ClickHouse for 15 m ([logging.md](../logging.md)) |
| homelab-logging | `HomelabLogExportQueueFull` | warning | a collector's ClickHouse send queue is above 80 % for 10 m |
| homelab-logging | `HomelabLogsNotArriving` | warning | the agents read no container log line for 30 m |
| homelab-logging | `HomelabClickHouseDown` | warning | the operator's metrics exporter cannot read ClickHouse for 10 m |
| homelab-logging | `HomelabClickHouseRejectedInserts` | warning | ClickHouse rejected inserts (too many parts) in the last 5 m |
| homelab-logging | `HomelabClickHouseTooManyParts` | warning | a partition has more than 150 active parts for 15 m |
| homelab-service-mesh | `HomelabIstiodDown` | warning | no istiod answers the scrape for 10 m ([service-mesh.md](../service-mesh.md)) |
| homelab-service-mesh | `HomelabMeshNodeAgentNotReady` | warning | `ztunnel` or `istio-cni-node` is not ready on every node for 15 m |
| homelab-service-mesh | `HomelabIstioXdsRejects` | warning | ztunnel or a waypoint rejects istiod's configuration for 15 m |

The `homelab-logging` rules follow the opentelemetry-collector chart's default rules and
Altinity's `prometheus-alert-rules-clickhouse.yaml`, restated at `warning` (the chart's own are
all `critical`); the log store is diagnostic, so its failures never page at night. The Traefik
rules read `exported_service`: the scrape's own `service` label (the metrics Service) displaces
Traefik's backend label.

Add a rule next to these (Prometheus `$labels` escaped as in the file), give it a `severity`
label the table above routes, and run `task verify:text`: kubeconform validates the
Application and the snapshot records the change.

**Where the metrics come from.** The monitoring CRDs (ServiceMonitor, PodMonitor,
PrometheusRule) are installed by the bootstrap chart's `prometheus-operator-crds` Application
at wave -1, before ArgoCD (wave 1) and every addon, so any chart can render its own monitor;
kube-prometheus-stack (wave 9) runs with `crds.enabled=false` and discovers monitors
cluster-wide. ArgoCD (controller, server, repo-server, ApplicationSet, notifications;
`charts/bootstrap/values.yaml`) and cert-manager (`charts/addons/templates/cert-manager.yaml`)
render theirs; CloudNativePG clusters set `enablePodMonitor`. The CRD chart version in
`configuration/versions.yaml` must match the operator kube-prometheus-stack bundles. Renovate
carries both in its `Monitoring stack` PR (`.github/renovate.json5`), so merge that PR as a
pair; when bumping by hand, never leave the CRDs behind the operator (`helm show chart
kube-prometheus-stack --version <v>` prints the operator `appVersion`; pick the
`prometheus-operator-crds` release with the same one).

## Related

- `docs/runbooks/control-plane-storage.md`: the etcd alerts and what to do when they fire
- `docs/secrets.md`: how 1Password items reach the cluster
- `docs/project_notes/decisions.md` ADR-017: why routes and receivers live in the Application and not in an AlertmanagerConfig CR
