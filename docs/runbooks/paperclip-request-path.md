# Runbook: paperclip does not respond

Path of one request, and what records each hop:

| # | Hop | Evidence | Where |
|---|---|---|---|
| 1 | client -> UniFi gateway | IPFIX flow records, firewall syslog | ClickHouse ScopeName `netflowreceiver` / ServiceName `unifi-syslog`; dashboard "UniFi gateway flows and firewall" |
| 2 | gateway -> traefik-internal LB IP (Cilium L2 announcement) | flow records to the LB IP | "Paperclip request path" panel 5 (UniFi) |
| 3 | Cilium -> Traefik pod | Hubble flows, drops with reason | panel 5 (Hubble), `HomelabHubbleDropsHigh` |
| 4 | Traefik | access log (ClientHost, Duration, OriginDuration, OriginStatus, DownstreamStatus, RouterName, ServiceURL, RetryAttempts, User-Agent, TraceId), metrics, span | panels 2 and 3 |
| 5 | waypoint / ztunnel -> paperclip :3100 | `istio_requests_total` (waypoint, L7), `istio_tcp_*` (ztunnel), waypoint span | panel 4, panel 3 |
| 6 | paperclip pod | probe `paperclip-direct`, CPU, memory, restarts, readiness, container logs | panels 1 and 6, Explore logs |
| 7 | paperclip -> paperclip-postgres-rw | `cnpg_backends_total`, Hubble flows on 5432 | panel 6, panel 5 |

Open Grafana -> "Paperclip request path" with the time range around the failure.

## Decide which hop failed

1. **Probes (panel 1).** `paperclip-direct` failing = the pod or the database (go to 6/7).
   Only `paperclip-ingress` failing = DNS, Traefik or the waypoint (go to 4/5). Both green while
   users see failures = the break is outside the cluster (hops 1-2): the in-cluster ingress probe
   resolves the public name but Cilium short-circuits the LB address to Traefik without the L2
   hop.
2. **Access log (panel 2).** A request that reached Traefik is there. `DownstreamStatus 499` with
   `OriginStatus 0` = the client gave up before paperclip answered: compare `OriginDuration` to
   the client's timeout. `502/504` with `RetryAttempts > 0` = Traefik could not reach the
   backend (hop 5). No line at all for the client's IP at that time = the request never reached
   Traefik (hops 1-3).
3. **Trace (panel 3).** Click the TraceId: the Traefik span and the waypoint span show where the
   time went (Traefik -> waypoint -> app). Sampling is 10 %; for a specific failure use the
   access log.
4. **Network (panel 5).** Filter by the client IP (click ClientHost). A Hubble `DROPPED` flow
   names the reason (policy, no route, ...). UniFi flow records without a matching Traefik access
   log line = packets reached the LB address but not Traefik: check which node holds the L2
   lease (`kubectl -n kube-system get leases | rg cilium-l2announce`) and Cilium agent health.
5. **Pod/database (panel 6).** Restarts, readiness flaps or CPU at the limit around the failure;
   `cnpg_backends_total` at `max_connections` (100) means the app waits for connections.

Note on client IPs: traefik-internal uses `externalTrafficPolicy: Cluster`, so for requests
that entered via the LB address `ClientHost` is usually a node IP (SNAT). Correlate by time,
path and User-Agent, or by the UniFi flow record's source. `Local` would keep the client address,
but the Cilium L2 lease holder must then run a Traefik pod or traffic is dropped; that trade-off
is not taken here.

## Queries

```sql
-- everything about one trace
SELECT Timestamp, ServiceName, SpanName, Duration / 1e6 AS ms, StatusCode, SpanAttributes
FROM otel.otel_traces WHERE TraceId = '<trace id>' ORDER BY Timestamp;

SELECT Timestamp, ServiceName, Body FROM otel.otel_logs
WHERE TraceId = '<trace id>' OR JSONExtractString(Body, 'TraceId') = '<trace id>'
ORDER BY Timestamp;

-- one client in a window, all hops
SELECT Timestamp, ServiceName,
       coalesce(nullIf(JSONExtractString(Body, 'RequestPath'), ''), LogAttributes['destination.port'],
                JSONExtractString(Body, 'flow', 'Summary')) AS what
FROM otel.otel_logs
WHERE Timestamp BETWEEN '2026-09-23 10:00:00' AND '2026-09-23 10:10:00'
  AND (JSONExtractString(Body, 'ClientHost') = '<client ip>'
       OR LogAttributes['source.address'] = '<client ip>'
       OR JSONExtractString(Body, 'flow', 'IP', 'source') = '<client ip>')
ORDER BY Timestamp;

-- slow or failed paperclip requests at Traefik
SELECT Timestamp, JSONExtractString(Body, 'RequestPath') AS path,
       JSONExtractInt(Body, 'DownstreamStatus') AS status, JSONExtractInt(Body, 'OriginStatus') AS origin,
       JSONExtractFloat(Body, 'OriginDuration') / 1e6 AS origin_ms, JSONExtractString(Body, 'TraceId') AS trace
FROM otel.otel_logs
WHERE ResourceAttributes['k8s.namespace.name'] = 'traefik'
  AND JSONExtractString(Body, 'RequestHost') LIKE 'paperclip.%'
  AND (status >= 499 OR origin_ms > 2000)
ORDER BY Timestamp DESC LIMIT 200;

-- dropped flows touching paperclip or traefik
SELECT Timestamp, JSONExtractString(Body, 'flow', 'drop_reason_desc') AS reason,
       JSONExtractString(Body, 'flow', 'Summary') AS summary
FROM otel.otel_logs
WHERE ServiceName = 'hubble' AND JSONExtractString(Body, 'flow', 'verdict') = 'DROPPED'
  AND Timestamp > now() - INTERVAL 1 DAY
ORDER BY Timestamp DESC;
```

Alerts that point here: `HomelabProbeFailing`, `HomelabProbeSlow` (homelab-probes),
`HomelabTraefikBackendErrors`, `HomelabTraefikBackendSlow` (homelab-ingress),
`HomelabHubbleDropsHigh` (homelab-network).
