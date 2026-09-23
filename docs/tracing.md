# Distributed tracing: OTLP -> ClickHouse -> Grafana

Traces use the same store as logs (docs/logging.md): the OpenTelemetry gateway collector
receives OTLP and writes `otel.otel_traces` with the same 90-day TTL (`logging.retention`,
2160h). One retention for both keeps a log line and its trace alive for the same window, which is
what makes TraceId links useful. Decision record: ADR-021.

| Sender | How | Sampling |
|---|---|---|
| Traefik (both releases) | starts or continues W3C `traceparent`, forwards it to the backend, OTLP gRPC to the gateway; the JSON access log carries `TraceId` and `SpanId` | `traefik*.tracing.sampleRate` in `configuration/templates/helm-addons.tmpl`: 0.1 homelab, 1.0 Kind |
| Istio waypoints | istiod `meshConfig.extensionProviders` `otel-tracing` + Telemetry `istio-system/mesh-default` (charts/istio-config) | `istio.tracing.samplingPercentage`: 10 homelab, 100 Kind |
| Applications | OTLP to `otel-collector-gateway.observability.svc.cluster.local:4317` (gRPC) or `:4318` (HTTP) | the application's own |

ztunnel is L4 only and emits no spans: a namespace needs a waypoint
(`SERVICE_MESH_WAYPOINT_NAMESPACES`, docs/service-mesh.md) for mesh spans. Traefik samples
independently of the mesh; a request sampled by Traefik carries the sampled flag in
`traceparent`, and the waypoint follows it.

Outside the cluster: OTLP/HTTP with TLS at `https://otlp.<DOMAIN>` (internal ingress,
`OTLP_HOSTNAME`), or plain OTLP on `otel.<DOMAIN>:4317/4318` (the gateway's LoadBalancer, LAN only).

## Send traces from an app

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://otel-collector-gateway.observability.svc.cluster.local:4318
  - name: OTEL_SERVICE_NAME
    value: my-app
  - name: OTEL_TRACES_SAMPLER
    value: parentbased_traceidratio
  - name: OTEL_TRACES_SAMPLER_ARG
    value: "0.1"
```

The gateway adds `k8s.*` resource attributes from the sending pod's address. Paperclip keeps its
Instance `observability.metrics` off: the operator's OTEL preload crashes images without
instrumentation (docs/apps/paperclip.md); its spans come from Traefik and the waypoint.

## Find a trace in Grafana

- **Explore -> ClickHouse -> Traces**: search by service, span name or duration; the trace view
  opens from a TraceId. In the Logs query type a log line with a `TraceId` links to its trace.
- **Dashboards**: "OpenTelemetry Traces Explorer" and "OpenTelemetry Logs Explorer" (shipped with
  the ClickHouse plugin), "Paperclip request path" (click a TraceId in the access-log table).

```sql
SELECT Timestamp, ServiceName, SpanName, Duration / 1e6 AS ms, StatusCode
FROM otel.otel_traces WHERE TraceId = '<32 hex>' ORDER BY Timestamp;

-- the access-log line of the same request
SELECT Timestamp, Body FROM otel.otel_logs
WHERE ResourceAttributes['k8s.namespace.name'] = 'traefik'
  AND JSONExtractString(Body, 'TraceId') = '<32 hex>';
```

## Alerts

`HomelabTraceExportFailing` (spans not written to ClickHouse), `HomelabTelemetryRefused`
(a receiver refuses spans or log records), `HomelabLogExportQueueFull` (any exporter queue);
docs/runbooks/alerting.md.
