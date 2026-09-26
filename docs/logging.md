# Cluster logs: OpenTelemetry -> ClickHouse -> Grafana

Every container log line, every Kubernetes event, the filtered Hubble flow log, the UniFi
gateway's syslog and NetFlow/IPFIX records and OTLP logs from applications land in ClickHouse,
and Grafana queries them through the ClickHouse datasource. The Envoy Gateway proxies write JSON
access logs to stdout (EnvoyProxy `telemetry.accessLog`, charts/envoy-gateway-config), so ingress
requests (gateway, client, host, path, status, response flags, durations, upstream, trace_id) are
in the same store. Traces: docs/tracing.md. Decision records: ADR-019, ADR-021.

```mermaid
flowchart LR
  pods["/var/log/pods on every node"] --> agent["otel-collector-agent\nDaemonSet: filelog + k8s_attributes"]
  hubble["Hubble flow log\n/var/run/cilium/hubble"] --> agent
  api["Kubernetes events"] --> cluster["otel-collector-cluster\n1 replica: k8sobjects"]
  unifi["UniFi gateway\nsyslog 514, IPFIX 2055"] --> gw["otel-collector-gateway\nOTLP, syslog, netflow"]
  apps["apps, Envoy Gateway, waypoints (OTLP)"] --> gw
  agent --> ch[("ClickHouse logs\notel.otel_logs + otel_traces, TTL 90 d")]
  cluster --> ch
  gw --> ch
  ch --> grafana["Grafana\nClickHouse datasource"]
```

| Piece | Where | Wave |
|---|---|---|
| Passwords of the ClickHouse users `otel` and `grafana` | `charts/clickhouse-dependencies` (OnePasswordItems) | 8 |
| Grafana plugin, datasource `ClickHouse` (uid `clickhouse-logs`) | `charts/addons/templates/kube-prometheus-stack.yaml` | 9 |
| Altinity clickhouse-operator (CRDs, metrics exporter, ServiceMonitor, dashboards) | `charts/addons/templates/logging.yaml` | 10 |
| `ClickHouseInstallation/logs` on `STORAGE_CLASS_ISCSI_SSD`, dashboards "Cluster logs", "Network flows and security" | `charts/clickhouse` | 11 |
| `otel-collector-agent` (DaemonSet), `otel-collector-cluster` (events), `otel-collector-gateway` (OTLP, UniFi) | `charts/addons/templates/logging.yaml` | 12 |

Everything runs in namespace `observability` (PodSecurity `privileged`: the agent mounts
`/var/log/pods` and `/var/lib/otelcol` from the host and runs as root because Talos writes
container logs root-owned `0640`). Versions: `configuration/versions.yaml` keys
`opentelemetry-collector`, `altinity-clickhouse-operator`, `clickhouse-server`,
`grafana-clickhouse-datasource`.

## 1Password items (homelab)

| Item (`configuration/` key) | Field | Used by |
|---|---|---|
| `clickhouse-otel` (`CLICKHOUSE_OTEL_1P_PATH`) | `password` | ClickHouse user `otel` (writer), the collectors |
| `clickhouse-grafana` (`CLICKHOUSE_GRAFANA_1P_PATH`) | `password` | ClickHouse user `grafana` (read-only), the Grafana datasource |

Create both before the first sync; Grafana does not start without Secret
`monitoring/clickhouse-grafana`. Generate each with `openssl rand -base64 32`. Kind seeds
throwaway values from `localdev/fakes/secrets.yaml`.

## Query logs in Grafana

- **Dashboards -> "Cluster logs"**: log volume per namespace, Envoy Gateway requests
  that returned 5xx or took longer than 1 s, and a log panel filtered by namespace and a
  "Contains" search box.
- **Explore -> ClickHouse**: switch the query type to *Logs*; the OpenTelemetry mode already
  points at `otel.otel_logs`. SQL works as well:

```sql
-- last 15 minutes of one app
SELECT Timestamp, Body
FROM otel.otel_logs
WHERE Timestamp > now() - INTERVAL 15 MINUTE
  AND ResourceAttributes['k8s.namespace.name'] = 'paperclip'
ORDER BY Timestamp DESC LIMIT 200;

-- slow or failing requests to one host, from the Envoy Gateway access log
SELECT Timestamp,
       JSONExtractString(Body, 'gateway') AS gateway,
       JSONExtractString(Body, 'path') AS path,
       JSONExtractInt(Body, 'response_code') AS status,
       JSONExtractString(Body, 'response_flags') AS flags,
       JSONExtractFloat(Body, 'duration_ms') AS ms
FROM otel.otel_logs
WHERE ResourceAttributes['k8s.namespace.name'] = 'envoy-gateway-system'
  AND JSONExtractString(Body, 'authority') LIKE 'paperclip.%'
  AND (status >= 500 OR status = 0 OR ms > 1000)
ORDER BY Timestamp DESC LIMIT 200;
```

Access log fields (one JSON object per request, container `envoy`): `start_time`, `gateway`,
`client_ip`, `x_forwarded_for`, `method`, `authority`, `path`, `protocol`, `response_code`,
`response_flags` (Envoy's short codes: `DC` client gave up, `UF`/`UH`/`UR`/`UT` upstream
failure, no healthy host, reset, timeout, `NR` no route), `response_code_details`,
`upstream_host`, `upstream_cluster` (`httproute/<namespace>/<route>/rule/<n>`), `route_name`,
`duration_ms`, `upstream_service_time_ms`, `bytes_received`, `bytes_sent`, `user_agent`,
`request_id`, `traceparent`, `trace_id`.

Useful resource attributes: `k8s.namespace.name`, `k8s.pod.name`, `k8s.container.name`,
`k8s.deployment.name`, `k8s.node.name`. `ServiceName` is the pod's `service.name` if it sets
one, otherwise the container name. Events from `otel-collector-cluster` carry the event
object as JSON in `Body`.

## Retention (90 days)

The ClickHouse exporter creates `otel.otel_logs` on first start (`create_schema: true`) with
`TTL TimestampTime + toIntervalDay(90)` from `logging.retention: 2160h` in
`configuration/templates/helm-addons.tmpl`; ClickHouse drops expired parts during merges. The
exporter only sets the TTL when it creates the table, so changing `retention` later also needs:

```sql
ALTER TABLE otel.otel_logs MODIFY TTL TimestampTime + toIntervalDay(<days>);
```

Check the current TTL with `SELECT engine_full FROM system.tables WHERE name = 'otel_logs'`
(the `logging` e2e test asserts it is set; `otel_traces` gets the same TTL).

**Sizing (100Gi in homelab).** Estimate for 90 days, ClickHouse compressing text about 8-10x:
container logs ~2-4 GB/day raw -> 20-40 GB; Envoy access logs are part of that; Hubble flow
log (paperclip + envoy-gateway-system + drops) ~0.2 GB/day -> ~2 GB; UniFi IPFIX for a home network,
~50k flows/h at ~60 B compressed -> ~6 GB; traces at 10 % sampling -> a few GB. Total ~35-55 GB,
so 100Gi leaves headroom. Measure the real rate after a week:

```sql
SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, min(min_date), max(max_date)
FROM system.parts WHERE database = 'otel' AND active GROUP BY table;
```

`KubePersistentVolumeFillingUp` (chart default rule) warns before the volume fills; grow the
PVC (iSCSI class supports expansion) or shorten `logging.retention`.

## UniFi gateway (syslog and NetFlow)

The `unifi-gateway` Terragrunt unit provisions the exports when `LOGGING_ENABLED` is `"true"`
(the default; the same key turns the log pipeline on in `charts/addons`), pointing them at
`OTEL_LB_IP` whether or not the collector is up yet:

| Setting (controller key) | Terraform | Values |
|---|---|---|
| Activity logging, SIEM server (`rsyslogd`) | `unifi_setting.syslog` (`ubiquiti-community/unifi` >= 0.53) | enabled, `OTEL_LB_IP`:514, all categories; the "this controller" flags off (they make the controller the destination instead of the SIEM server) |
| NetFlow (`netflow`) | `terraform_data.netflow` running `scripts/unifi-setting.ts apply netflow` | enabled, `OTEL_LB_IP`:2055, version 10 (IPFIX), `network_ids` = every enabled corporate and guest network (`--all-networks`, required by the controller); sampling untouched |

```bash
task tf:init:component COMPONENT=unifi-gateway TF_ARGS=-upgrade   # once: provider 0.41 -> 0.56
task tf:plan:component COMPONENT=unifi-gateway
task tf:apply:component COMPONENT=unifi-gateway
```

The Taskfile exports `configuration/resolved.json` (gitignored) before each `tf:*` task; the unit
reads `LOGGING_ENABLED` and `OTEL_LB_IP` from it. The provider has no NetFlow setting, so the
script logs in to the console and merges the fields into the `netflow` setting (ADR-024); it runs
again only when those values change, so a NetFlow edit made in the UI is not reverted until
then. `op run --env-file=.env.op -- bun scripts/unifi-setting.ts get netflow --insecure` shows
the live values. Turning the flag off stops managing both settings and leaves the gateway as it
is. NetFlow leaves the gateway from `GATEWAY_IP`, its address on the homelab VLAN, because
`OTEL_LB_IP` is in that subnet. Syslog does not: the console and every switch and access point
send it from their own management addresses on other networks, so those CIDRs go in
`OTEL_SOURCE_RANGES` or Cilium drops them and `HomelabUniFiTelemetrySilent` fires for `syslog`.

The UI paths below are the manual fallback, for example to add per-rule firewall logging.

What UniFi Network exports ([UniFi System Logs & SIEM Integration](https://help.ui.com/hc/en-us/articles/33349041044119-UniFi-System-Logs-SIEM-Integration),
[Traffic Flows and Traffic Logging](https://help.ui.com/hc/en-us/articles/32201256219799-Traffic-Flows-and-Traffic-Logging-in-UniFi-Network)):

| Export | UI path (UniFi Network 9.x) | Protocol / format | Target here |
|---|---|---|---|
| Activity logging (system, admin, client, IDS/IPS) | Settings -> Control Plane -> Integrations -> Activity Logging (Syslog) -> SIEM Server | CEF inside syslog, UDP | `OTEL_LB_IP`, port 514 |
| Firewall and traffic logs | Settings -> CyberSecure -> Traffic Logging -> Activity Logging (Syslog) -> SIEM Server; per-rule "Syslog Logging" in Settings -> Policy Engine | syslog, UDP | `OTEL_LB_IP`, port 514 |
| Flow records | Settings -> CyberSecure -> Traffic Logging -> NetFlow (IPFIX) | IPFIX (NetFlow v10), UDP, sampled | `OTEL_LB_IP`, port 2055 |

The fields take an IP address, so enter `OTEL_LB_IP` rather than `otel.<DOMAIN>` (the name
resolves to the same address for everything else). Community reports for Network 9.3.x mention
the IPFIX export sending only templates; `HomelabUniFiTelemetrySilent` fires if nothing arrives.

The gateway collector listens on 5514 (syslog, UDP and TCP, RFC 3164) and 2055 (NetFlow v5/v9,
IPFIX) behind the Service ports 514 and 2055 of the LoadBalancer `otel-collector-gateway`
(`io.cilium/lb-ipam-ips: OTEL_LB_IP`, external-dns `otel.<DOMAIN>`), which also serves OTLP
4317/4318. `loadBalancerSourceRanges` limits it to `NFS_SHARE_ALLOW` plus `OTEL_SOURCE_RANGES`; Cilium enforces
it at the load balancer before any NAT. There is no authentication on syslog or NetFlow, so the
address stays internal: never forward these ports on the gateway. The Service keeps
`externalTrafficPolicy: Cluster` (the L2 announcement and BGP speakers are not the nodes running
the collector), so the source address seen by the collector is a node's; the syslog message
carries the gateway's hostname and flow records carry the flow's own addresses.

Records: syslog lines get ServiceName `unifi-syslog`, the CEF header in `LogAttributes`
(`cef_vendor`, `cef_product`, `cef_name`, `cef_severity`, `cef_extension`); flows get
ServiceName `unifi-netflow` (set by `transform/service-name`; empty on older records) and
come from ScopeName `otelcol/netflowreceiver`, which the dashboard filters on, with
`source.address`, `source.port`, `destination.address`, `destination.port`, `network.transport`,
`flow.io.bytes`, `flow.io.packets`, `flow.start`, `flow.end`, `flow.in_if`, `flow.out_if`,
`flow.tcp_flags`.

### Dashboard "Network flows and security"

`charts/clickhouse/dashboards/network-flows.json` (uid `network-flows`), filtered by network,
protocol, source and destination IP:

| Row | Panels |
|---|---|
| Overview | bytes, packets, flow records, active local hosts, top protocol, threat events, firewall blocks, Hubble policy drops |
| Traffic | throughput by source network and by direction (egress, ingress, internal), network-to-network matrix, top sources and destinations, Envoy Gateway requests by listener |
| Flows | top conversations, protocol mix, top destination ports with service names, flow records |
| Security | UniFi security events over time, top blocked sources, IDS/IPS and threat events (CEF `UNIFIcategory=Security`), risky destination ports (SMB, RDP, databases, ...), inbound from the internet to service ports, scan-like local hosts, hourly egress outliers (z-score), Hubble drops by reason and policy drops |
| UniFi syslog | raw lines (collapsed) |

`NETWORK_NAMES` (`name=CIDR` pairs, comma-separated, e.g. `homelab=192.168.1.0/24`) names the
subnets; unnamed private addresses show as their /24 and public ones as `internet`. It is PII like
`NFS_SHARE_ALLOW`, so it lives in the environment file and reaches the dashboard through the
`clickhouse` Application's `valuesObject`. IPFIX records are unidirectional: a reply counts
against the opposite direction, and "inbound from the internet" keeps only flows whose destination
port is below both the source port and 32768.

Counter: the `netflow` receiver emits no `otelcol_receiver_*` self-metrics, so the gateway
counts UniFi records itself. The logs pipeline also exports to the `count/unifi` connector,
which counts records from scope `otelcol/netflowreceiver` and ServiceName `unifi-syslog`; the
`metrics/unifi` pipeline turns the counts into `homelab_unifi_telemetry_records_total{source="netflow"|"syslog"}`
on port 8889 (`prometheus/unifi`, `unifi-metrics` endpoint of the gateway PodMonitor). A
series appears with the first record of its source and expires one hour after the last, so
`HomelabUniFiTelemetrySilent` fires on a zero rate or an absent series per source.

## Operate

```bash
kubectl -n observability get chi,pods
kubectl -n observability exec -it chi-logs-logs-0-0-0 -- clickhouse-client \
  --query "SELECT count(), min(Timestamp) FROM otel.otel_logs"
```

Alerts (`homelab-logging`, `homelab-ingress`): [runbooks/alerting.md](runbooks/alerting.md).
Paperclip end to end: [runbooks/paperclip-request-path.md](runbooks/paperclip-request-path.md).
Dashboards: "OpenTelemetry Collector" (grafana.com 15983), "Envoy Gateway Global", "Envoy
Global", "Envoy Clusters", "Resources Monitor" and "Ingress overview" (charts/grafana-config) and
the Altinity ClickHouse dashboards shipped by the operator chart.
