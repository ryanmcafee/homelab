# Hubble: Cilium flow visibility

Hubble runs inside the Cilium agents and records every flow the datapath sees. In homelab it
provides:

| Piece | Where |
|---|---|
| Relay + UI at `https://hubble.<DOMAIN>` (HTTPRoute on `envoy-internal`, `HUBBLE_HOSTNAME`) | Cilium values (`hubble.relay`, `hubble.ui`); HTTPRoute in `charts/cilium-config` |
| Flow metrics `hubble_*` (dns, drop, tcp, flow, port-distribution, icmp; flow and drop labelled by workload/namespace) | Cilium values `hubble.metrics`, ServiceMonitor `hubble` |
| Agent `cilium_*` and operator metrics | `prometheus.metricsService`, `operator.prometheus.metricsService`; ServiceMonitors `cilium-agent`, `cilium-operator` |
| Upstream Grafana dashboards: Cilium agent (16611), operator (16612), Hubble (16613), Hubble network (19424) and DNS (19425) overview | grafana.com, "Homelab" folder (the chart's own dashboard ConfigMaps would add ~0.5 MB to the Talos inline manifest) |
| Flow log in ClickHouse (ServiceName `hubble`) | `hubble.export.static` -> `/var/run/cilium/hubble/events.log` on each node -> `otel-collector-agent` (`file_log/hubble`) |

The flow log keeps every flow from or to namespaces `paperclip` and `envoy-gateway-system` (`GATEWAY_NAMESPACE`), and every
`DROPPED` or `ERROR` verdict cluster-wide (the allowList in the cilium block of
`configuration/templates/helm-addons.tmpl`), 50 MB x 3 files per node before rotation. One
JSON object per line: `flow` (verdict, drop_reason_desc, IP.source/destination,
l4.TCP/UDP ports, source/destination namespace and pod_name, Summary), `node_name`, `time`.

```sql
SELECT Timestamp,
       JSONExtractString(Body, 'flow', 'verdict') AS verdict,
       JSONExtractString(Body, 'flow', 'drop_reason_desc') AS reason,
       JSONExtractString(Body, 'flow', 'IP', 'source') AS src,
       JSONExtractString(Body, 'flow', 'IP', 'destination') AS dst,
       JSONExtractUInt(Body, 'flow', 'l4', 'TCP', 'destination_port') AS dport
FROM otel.otel_logs
WHERE ServiceName = 'hubble' AND verdict = 'DROPPED' AND Timestamp > now() - INTERVAL 1 HOUR
ORDER BY Timestamp DESC LIMIT 100;
```

## Why the ServiceMonitors are not in the Cilium chart

Talos applies Cilium from inline manifests at bootstrap, before ArgoCD and before the
monitoring CRDs exist, and an unknown kind would fail that apply. The Cilium values therefore
render only Services and ConfigMaps; the ServiceMonitors and the UI HTTPRoute are GitOps objects in
`charts/cilium-config` (wave 8). `task cilium:render` now renders from the same
`cilium.values` map the adopting `cilium` Application uses (no separate `--set` list to drift).

## Rollout (human, homelab)

```bash
task render && task render:push && task tf:plan && task tf:apply
kubectl -n kube-system rollout restart daemonset/cilium deployment/cilium-operator
```

Kind runs Cilium without Hubble (smaller CI footprint), so the flow export and these monitors are
verified by level 0 renders only.

## With the Istio ambient mesh

Enrolled pods talk HBONE: between nodes Hubble sees pod IP -> pod IP on TCP 15008 (mTLS), not
the application port, and has no L7 view of that traffic; the waypoint and ztunnel metrics and
spans cover it (docs/service-mesh.md). Traffic from outside the mesh (Envoy Gateway ->
paperclip waypoint) and every drop stay visible as before. Do not add Cilium L7 policies to
enrolled workloads.

## Alerts

`homelab-network`: `HomelabCiliumAgentNotReady` (critical), `HomelabCiliumOperatorDown`,
`HomelabCiliumUnreachableNodes`, `HomelabCiliumEndpointRegenerationFailing`,
`HomelabCiliumBPFMapPressure`, `HomelabHubbleDropsHigh` (docs/runbooks/alerting.md).
