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

**What is in the population.** Requests and bus messages the service serves for somebody.
Kubelet probes and scrapes of `/metrics` are **not** observed: at an ordinary 10s probe period
they outnumber user requests about ten to one, which divides the measured error ratio by
eleven. A user path failing 10% of the time reads 0.91% and pages nobody.

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
  rate(platform_request_duration_seconds_count{outcome="error",code!="quota"}[5m])
)
/
sum by (service, environment, tenant, kind, route) (
  rate(platform_request_duration_seconds_count[5m])
)
```

`code!="quota"` excludes quota denials, which are the policy working as designed. Drop that
selector only when you deliberately want total failures rather than the availability SLI.

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
SLO, alert and recording rule must drop **all of them, `job` included**, or a rollout replaces
the series set underneath a burn rate at exactly the moment a deploy is the suspect. Use the
positive form, which cannot silently retain a label a future Prometheus release starts
attaching:

```promql
sum by (service, environment, tenant, kind) (
  rate(platform_request_duration_seconds_count[5m])
)
```

`job` is kept in **canary analysis queries only** (section 6), where telling canary from stable
is the whole point. Keeping it in an SLO is the `pod` mistake with a longer fuse: during a
rollout the canary pods are scraped by both the root ServiceMonitor and the canary one, so one
service becomes two rows and the burn rate resets mid-deploy. Measured, one service mid-rollout:

```promql
count(platform:request_error:ratio5m)       = 2   # job retained
count(platform:request_error:ratio_rate5m)  = 1   # job dropped, continuous across the rollout
```

## 4. Suggested recording rules

The SRE owns whether these ship and under what names; they are here so the shape is agreed, not
to pre-empt that. Recording rules matter more than usual on this family because a burn-rate SLO
evaluates the same ratio over four windows.

Note the `code!="quota"` in the numerator: a quota denial is the policy working, and an
availability SLI that counts it lets one noisy tenant burn the service's budget.

```yaml
groups:
  - name: platform-red-v1
    interval: 30s
    rules:
      - record: platform:request:rate5m
        expr: |
          sum by (service, environment, tenant, kind) (
            rate(platform_request_duration_seconds_count[5m])
          )
      - record: platform:request_error:ratio5m
        expr: |
          sum by (service, environment, tenant, kind) (
            rate(platform_request_duration_seconds_count{outcome="error",code!="quota"}[5m])
          )
          /
          sum by (service, environment, tenant, kind) (
            rate(platform_request_duration_seconds_count[5m])
          )
```

## 5. A worked SLO

Two objectives, both stated against bucket boundaries the contract pins, because a threshold
between two boundaries is interpolated and the error bar is the width of the bucket.

| Objective | SLI | Target |
|---|---|---|
| Availability | 1 - error ratio over `kind="http"`, excluding `code="quota"` | 99.5% over 30d |
| Latency | fraction of successful requests under `le="0.25"` | 99% over 30d |

Latency SLI, exactly as written -- note that `le` is a string and must match the pinned
exposition form:

```promql
sum by (service, environment, tenant) (
  rate(platform_request_duration_seconds_bucket{kind="http",outcome="success",le="0.25"}[5m])
)
/
sum by (service, environment, tenant) (
  rate(platform_request_duration_seconds_count{kind="http",outcome="success"}[5m])
)
```

A multi-window multi-burn-rate alert is built from the availability SLI over `5m`/`1h`,
`30m`/`6h`, `2h`/`1d` and `6h`/`3d`, with burn factors **14.4 / 6 / 3 / 1** -- the first two
paging, the last two ticketing.

There is no `0.5x` tier. At a 99.5% objective a 0.5x burn rate is a 0.25% error ratio, and a
service sitting at 0.25% errors is *inside* its budget -- at that rate the budget lasts 60 days,
twice the window. Measured: the `0.5x` form over `6h`/`3d` fires on a service erroring at 0.40%,
which is comfortably meeting 99.5%. An alert that fires on a compliant service is what teaches a
responder to ignore the next one. `1x` over the 3d window is the correct ticket tier: it means
the budget is being spent exactly as fast as the window allows.

Two clauses it must carry:

- **Absence is not health.** A service that stopped exposing produces no error ratio, not a 0%
  one. Pair every burn-rate alert with
  `absent_over_time(platform_request_duration_seconds_count{service="..."}[10m])`, or the
  loudest possible failure is the quietest signal on the dashboard.
- **Error budget gating is day-31 work.** It needs roughly 30 days of SLI history before it can
  gate anything, and it is out of scope here. This is the contract it will rest on.

Every alert rule written against this contract gets a `promtool` unit test in `tests/alerts/` --
an alert rule that has never fired in a test is not an alert rule. That directory and its CI gate
**do not exist yet**; the SRE is building them alongside the first rules. Stated rather than
implied, because this document previously described the gate as one that already covers the
JetStream rules, and it does not.

## 6. A worked canary AnalysisTemplate

Canary and stable are told apart by the scrape-attached `job` label, produced by the Rollout's
canary Service and its own ServiceMonitor. The service must not emit a version or
pod-template-hash label of its own: those change on every deploy, so they are unbounded over
time and the contract forbids them.

Three things this template does that a first draft does not, each of which is a bug if you drop
it. **Copy it as written.**

1. **Every aggregate is wrapped in `scalar()`.** An empty vector is *not* NaN: `rate()` over
   absent series returns nothing, so the division never happens and `isNaN(result)` never fires.
   The Prometheus provider scores an empty result as an Error against `consecutiveErrorLimit`,
   not the Failed you intended -- so the guard against "the canary crashed before serving
   anything" looks right and does nothing. `scalar()` of an empty vector *is* NaN.
2. **No-data is Inconclusive, not Failed.** `guarantees.absence` requires that a canary must not
   *pass* on no-data; it does not require that it fail. Giving `successCondition` and
   `failureCondition` a deliberate gap -- both guarded with `!isNaN(result)` -- means NaN
   satisfies neither, which is how Argo produces Inconclusive and pauses for a human. Failing
   closed instead would roll back every release on a homelab with no traffic, which is the
   fork-ability contract breaking in the first place a new user meets it.
3. **`initialDelay` and a minimum-sample guard.** Without them the first measurement runs the
   instant the analysis starts, when a just-started pod has nothing in its `[5m]` window; two of
   those exhaust `failureLimit: 1` and the rollout aborts before the canary ever served a
   request. `+ 0 * scalar(... > 50)` makes the whole expression NaN under 50 requests in the
   window, because `0 * NaN` is NaN.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: red-v1-canary
spec:
  args:
    - name: canary-job      # the canary SERVICE's name, not the Rollout's (see below)
    - name: stable-job
    - name: service
  metrics:
    - name: error-ratio
      initialDelay: 5m      # at least the query window; a new pod has no [5m] history
      interval: 1m
      count: 5
      successCondition: "!isNaN(result) && result <= 0.01"
      failureCondition: "!isNaN(result) && result > 0.01"
      failureLimit: 1
      inconclusiveLimit: 3
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            scalar(sum(rate(platform_request_duration_seconds_count{
              job="{{args.canary-job}}",service="{{args.service}}",outcome="error"}[5m])))
            /
            scalar(sum(rate(platform_request_duration_seconds_count{
              job="{{args.canary-job}}",service="{{args.service}}"}[5m])))
            + 0 * scalar(sum(increase(platform_request_duration_seconds_count{
              job="{{args.canary-job}}",service="{{args.service}}"}[5m])) > 50)
    - name: error-ratio-vs-stable
      initialDelay: 5m
      interval: 1m
      count: 5
      successCondition: "!isNaN(result) && result <= 0.01"
      failureCondition: "!isNaN(result) && result > 0.01"
      failureLimit: 1
      inconclusiveLimit: 3
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            scalar(sum(rate(platform_request_duration_seconds_count{
              job="{{args.canary-job}}",service="{{args.service}}",outcome="error"}[5m])))
            / scalar(sum(rate(platform_request_duration_seconds_count{
              job="{{args.canary-job}}",service="{{args.service}}"}[5m])))
            -
            scalar(sum(rate(platform_request_duration_seconds_count{
              job="{{args.stable-job}}",service="{{args.service}}",outcome="error"}[5m])))
            / scalar(sum(rate(platform_request_duration_seconds_count{
              job="{{args.stable-job}}",service="{{args.service}}"}[5m])))
    - name: p99-latency
      initialDelay: 5m
      interval: 1m
      count: 5
      successCondition: "!isNaN(result) && result <= 0.5"
      failureCondition: "!isNaN(result) && result > 0.5"
      failureLimit: 1
      inconclusiveLimit: 3
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99, sum by (le) (
              rate(platform_request_duration_seconds_bucket{
                job="{{args.canary-job}}",service="{{args.service}}"}[5m])
            ))
```

`error-ratio-vs-stable` is the metric most worth having. A service with a pre-existing 3% error
rate is undeployable against an absolute `result > 0.01` and fine against
`canary - stable > 0.01`: a canary is a comparison, and the absolute threshold is a statement
about the service that belongs in the SLO.

The p99 guardrail is `0.5`, a pinned boundary. A threshold between two boundaries is
interpolated and its error bar is the bucket width.

### Three things about `job` that are not obvious

- **`job` is the Service name.** prometheus-operator relabels `__meta_kubernetes_service_name`
  to `job`, unless `ServiceMonitor.spec.jobLabel` names a label on the Service. Pass the canary
  **Service** name, not the Rollout name; they are not the same string.
- **Canary pods are scraped twice.** The root Service still selects canary pods during a
  rollout, so with a ServiceMonitor on each, one pod's series exist under two `job` values. That
  is what makes a retained `job` in an SLO (section 3) a real bug.
- **`job=<canary-svc>` is stale after promotion.** The controller re-points the canary Service
  selector at the new stable hash, so the same query then returns stable traffic. Harmless
  inside an `AnalysisRun`, which is scoped to the rollout; a trap for a dashboard.

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
4. Do **not** observe health, readiness or liveness endpoints, or `/metrics` itself.
5. Template the `route` label; anything unmatched is `__other__`, never the raw path. At most 25
   distinct values.
6. Classify `outcome` by the table in the contract file -- 5xx and 429 are errors, other 4xx are
   not. Split 429 into `code="throttled"` (you shed load) and `code="quota"` (the caller hit a
   configured limit).
7. Stop the clock at response headers for a streaming route and label it `kind="stream"`. Never
   record a long-lived response's full lifetime here -- it lands in `+Inf` and breaches the
   service's latency objective forever.
8. Emit `platform_build_info` and keep every build-identity string on it.
9. Label the workload `platform.mcafeeconsulting.com/metrics: red-v1` and ship a ServiceMonitor
   that selects it.

Steps 2-8 are what the shared SDK helper will do on the service's behalf once it exists; until
then they are review obligations, and the contract says so rather than implying a gate that is
not running.
