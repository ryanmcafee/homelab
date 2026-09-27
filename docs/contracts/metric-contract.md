# The RED metric contract

Normative. Decision record: ADR-041 in [`docs/project_notes/decisions.md`](../project_notes/decisions.md).
The machine-checkable artifact is [`contracts/observability/metrics.v1.yaml`](../../contracts/observability/metrics.v1.yaml),
gated by `scripts/metrics-contract_test.ts` in `task test:scripts`.

This document is the consumer's half. The contract file fixes the shape; everything below is
written against it and nothing below introduces a name the contract does not declare -- the
self-test fails if it does.

## 1. The shape in one paragraph

Every first-party control-plane service exposes one histogram,
`platform_request_duration_seconds`, on `/metrics` at a container port named `metrics`. Its
`_count` is the request rate, its `_bucket` is the duration distribution, and the error rate is
a ratio over the same `_count` selected on `outcome="error"`. Required labels are `service`,
`environment`, `tenant`, `kind`, `route` and `outcome`; `code` is optional on error series.
Buckets are pinned at 5ms..30s. A second metric, `platform_build_info`, is always 1 and carries
the build identity that must never appear on the RED family.

One instrument, not three, so the numerator and the denominator of the error rate cannot drift
apart. One set of buckets, not per service, so `histogram_quantile` over the sum of two
services' buckets means something.

## 2. The three signals

Window: use `5m` for canary analysis and short-window burn rates, `1h`/`6h` for long windows.
Never below `2m` -- it is under two scrape intervals and `rate()` returns no data.

**Rate** -- requests per second, by route:

```promql
sum by (service, environment, tenant, kind, route) (
  rate(platform_request_duration_seconds_count[5m])
)
```

**Error ratio** -- 0..1, aggregated away from `outcome` and `code` so the denominator is total:

```promql
sum by (service, environment, tenant, kind, route) (
  rate(platform_request_duration_seconds_count{outcome="error"}[5m])
)
/
sum by (service, environment, tenant, kind, route) (
  rate(platform_request_duration_seconds_count[5m])
)
```

**Duration** -- p99, aggregated across replicas before the quantile, never after:

```promql
histogram_quantile(0.99,
  sum by (service, environment, tenant, kind, route, le) (
    rate(platform_request_duration_seconds_bucket[5m])
  )
)
```

`le` must stay in the `by` list; dropping it leaves nothing for `histogram_quantile` to read.
Averaging per-replica quantiles instead is the other common form and it produces a number that
is not a quantile of anything.

## 3. Aggregating away the scrape labels

Prometheus attaches `job`, `instance`, `namespace`, `pod`, `container` and `endpoint`. Every
SLO and alert expression must drop `pod` and `instance`, or a rollout replaces the series set
underneath a burn rate at exactly the moment a deploy is the suspect:

```promql
sum without (pod, instance, container, endpoint) (
  rate(platform_request_duration_seconds_count[5m])
)
```

`job` is the exception and is kept deliberately: it is how canary is told from stable.

## 4. Suggested recording rules

The SRE owns whether these ship and under what names; they are here so the shape is agreed, not
to pre-empt that. Recording rules matter more than usual on this family because a burn-rate SLO
evaluates the same ratio over four windows.

```yaml
groups:
  - name: platform-red-v1
    interval: 30s
    rules:
      - record: platform:request:rate5m
        expr: |
          sum without (pod, instance, container, endpoint) (
            rate(platform_request_duration_seconds_count[5m])
          )
      - record: platform:request_error:ratio5m
        expr: |
          sum without (pod, instance, container, endpoint, outcome, code) (
            rate(platform_request_duration_seconds_count{outcome="error"}[5m])
          )
          /
          sum without (pod, instance, container, endpoint, outcome, code) (
            rate(platform_request_duration_seconds_count[5m])
          )
```

## 5. A worked SLO

Two objectives, both stated against bucket boundaries the contract pins, because a threshold
between two boundaries is interpolated and the error bar is the width of the bucket.

| Objective | SLI | Target |
|---|---|---|
| Availability | 1 - error ratio over `kind="http"` | 99.5% over 30d |
| Latency | fraction of successful requests under `le="0.25"` | 99% over 30d |

Latency SLI, exactly as written -- note that `le` is a string and must match the pinned
exposition form:

```promql
sum without (pod, instance, container, endpoint) (
  rate(platform_request_duration_seconds_bucket{kind="http",outcome="success",le="0.25"}[5m])
)
/
sum without (pod, instance, container, endpoint) (
  rate(platform_request_duration_seconds_count{kind="http",outcome="success"}[5m])
)
```

A multi-window multi-burn-rate alert (the 14.4x/6x/1x/0.5x shape) is built from the availability
SLI over `5m`/`1h`, `30m`/`6h`, `2h`/`1d` and `6h`/`3d`. Two clauses it must carry:

- **Absence is not health.** A service that stopped exposing produces no error ratio, not a 0%
  one. Pair every burn-rate alert with
  `absent_over_time(platform_request_duration_seconds_count{service="..."}[10m])`, or the
  loudest possible failure is the quietest signal on the dashboard.
- **Error budget gating is day-31 work.** It needs roughly 30 days of SLI history before it can
  gate anything, and it is out of scope here. This is the contract it will rest on.

Every alert rule written against this contract gets a `promtool` unit test in `tests/alerts/`,
the same gate that already covers the JetStream rules -- an alert rule that has never fired in a
test is not an alert rule.

## 6. A worked canary AnalysisTemplate

Canary and stable are told apart by the scrape-attached `job` label, produced by the Rollout's
canary Service and its own ServiceMonitor. The service must not emit a version or
pod-template-hash label of its own: those change on every deploy, so they are unbounded over
time and the contract forbids them.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: red-v1-canary
spec:
  args:
    - name: canary-job      # the canary Service's ServiceMonitor job label
    - name: service
  metrics:
    - name: error-ratio
      interval: 1m
      count: 5
      # No data fails the analysis. A canary that served nothing has not passed.
      failureCondition: isNaN(result) || result > 0.01
      successCondition: result <= 0.01
      failureLimit: 1
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(platform_request_duration_seconds_count{
              job="{{args.canary-job}}",service="{{args.service}}",outcome="error"}[5m]))
            /
            sum(rate(platform_request_duration_seconds_count{
              job="{{args.canary-job}}",service="{{args.service}}"}[5m]))
    - name: p99-latency
      interval: 1m
      count: 5
      failureCondition: isNaN(result) || result > 0.25
      successCondition: result <= 0.25
      failureLimit: 1
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99, sum by (le) (
              rate(platform_request_duration_seconds_bucket{
                job="{{args.canary-job}}",service="{{args.service}}"}[5m])
            ))
```

`isNaN(result)` in the failure condition is the absence clause from section 5 in its canary
form: an empty ratio is division by zero, and without that check a canary whose pods crash
before serving a request promotes cleanly.

## 7. The tenant label on a fork

`tenant` is required on every series from day one, and a homelab fork emits `tenant="local"` --
the same reserved value the CloudEvents envelope already requires of the same fork.

It is required now, on a surface with exactly one tenant, because adding a label later is a
breaking change in metrics even though it is an additive one in JSON. Adding `tenant` to an
existing family changes the identity of every series in it: recording rules keep evaluating,
dashboards keep rendering, burn rates reset to no-data, and nothing anywhere reports an error.
Emitting it now costs a fork one constant label and costs the commercial surface nothing later.

## 8. What a service author has to do

1. Expose `/metrics` on a port named `metrics`, scraped at 30s or faster.
2. Emit `platform_request_duration_seconds` with the six required labels and the pinned buckets.
3. Observe exactly once per attempt from a path that runs on success, on throw and on timeout.
4. Template the `route` label; anything unmatched is `__other__`, never the raw path.
5. Classify `outcome` by the table in the contract file -- 5xx and 429 are errors, other 4xx are
   not.
6. Emit `platform_build_info` and keep every build-identity string on it.
7. Label the workload `platform.mcafeeconsulting.com/metrics: red-v1` and ship a ServiceMonitor
   that selects it.

Steps 2-6 are what the shared SDK helper will do on the service's behalf once it exists; until
then they are review obligations, and the contract says so rather than implying a gate that is
not running.
