# Platform RED SLO: burn-rate alerts and the canary analysis

Every alert in the `platform-red-v1-slo` and `platform-red-v1-budget` rule groups annotates this
file. The groups cover two objectives over the `platform_request_duration_seconds` family defined by
`contracts/observability/metrics.v1.yaml`:

| Objective | SLI | Target | Window |
|---|---|---|---|
| `platform-http-availability` | non-quota errors / non-quota requests, `kind="http"` | 99.5% | 30d |
| `platform-http-latency` | successful requests completing under 250ms, `kind="http"` | 99% | 30d |

A 99.5% availability objective holds 3.6 hours of total outage over 30 days; a 14.4x burn
exhausts it in about 50 hours, which is why the fast tier pages and the slow tier does not.

> **Status: the rules are deployed; the canary template is not.** The `platform-red-v1` group
> ships in `charts/addons/templates/kube-prometheus-stack.yaml`, is unit-tested by
> `tests/alerts/platform-red-slo.test.yaml`, `platform-red-slo-budget.test.yaml` and `platform-red-slo-slow.test.yaml` (`task test:alerts`), and the Kind suite
> `tests/e2e/triage-agent` fires `PlatformRequestErrorBudgetBurningFast` against the triage agent
> intake, the first service to emit `platform_request_duration_seconds`. The `red-v1-canary`
> template ships with the first Rollout that uses it.

## Which alert fired

| Alert | Severity | Means | Go to |
|---|---|---|---|
| `PlatformRequestErrorBudgetBurningFast` | critical | 14.4x or 6x availability burn, confirmed on a short and a long window | [Availability burn](#availability-burn) |
| `PlatformRequestErrorBudgetBurningSlow` | warning | 3x or 1x burn over days | [Availability burn](#availability-burn) |
| `PlatformRequestLatencyBudgetBurningFast` | critical | 14.4x latency burn against 99% under 250ms | [Latency burn](#latency-burn) |
| `PlatformServiceMetricsAbsent` | critical | a service that was exposing RED metrics stopped | [Metrics absent](#metrics-absent) |
| `PrometheusRetentionTruncatesSLOWindow` | warning | `retentionSize` deleted data inside the 30d window | [Budget window and retention](#budget-window-and-retention) |

Every burn-rate alert requires **both** a long and a short window over threshold. A single alert is
already evidence that the problem is current, not a spike that has since recovered — the short
window is what expires the alert once the burn stops.

## Availability burn

**What the user sees.** A share of HTTP requests to `{{ $labels.service }}` is failing. The alert
value is the measured error ratio; at 10% errors the 30-day budget is gone in about 36 hours.

### 1. Confirm the scope

```promql
sum by (route, code) (
  rate(platform_request_duration_seconds_count{
    service="<service>", environment="<env>", outcome="error", code!="quota"}[5m])
)
```

`route` tells you whether one endpoint is failing or all of them. `code` tells you which failure
mode:

| `code` | Meaning | Usually |
|---|---|---|
| `internal` | the handler threw or returned 5xx | a bad release, or a dependency the service is not degrading around |
| `unavailable` | a dependency the service depends on is down | follow the dependency, not this service |
| `timeout` | the service abandoned the request | saturation, or a dependency that got slow rather than down |
| `throttled` | the service shed load because it was overloaded | capacity; this is the overload signal |
| `quota` | a principal exceeded a configured limit | **not in this SLI at all** — see [Quota is excluded](#quota-is-excluded-from-both-sides) |

### 2. Decide whether to roll back

Compare against the deploy. If a rollout is in progress, the canary analysis below should already
have caught it; if a rollout **completed** in the last hour, roll back first and diagnose after —
MTTR over root cause.

```promql
count by (service, environment) (
  count by (service, environment, version, revision) (
    count_over_time(platform_build_info{service="<service>", environment="<env>"}[1h])
  )
) > 1
```

A non-empty result means more than one `version`/`revision` ran in the last hour: a deploy
happened, so roll back. It is also non-empty while a canary is in progress (stable and canary
both expose) and after a rollout was already rolled back, so check
`kubectl argo rollouts get rollout <rollout> -n <namespace>` before acting. Do not use `changes()` here; `platform_build_info` is always 1 and a deploy
starts a new series, so `changes()` reads 0 before and after every release.

### 3. If it is not a release

Follow `code` from step 1 to the dependency. `unavailable` and `timeout` both mean the fault is
probably downstream; check that service's own availability SLI before touching this one.

## Latency burn

`PlatformRequestLatencyBudgetBurningFast` means more than 14.4% of **successful** `kind="http"`
requests took longer than 250ms. Errors are excluded on both sides, so a service that starts
failing fast will not trip this alert — it trips the availability alert instead.

```promql
histogram_quantile(0.99, sum by (route, le) (
  rate(platform_request_duration_seconds_bucket{
    service="<service>", environment="<env>", outcome="success"}[5m])
))
```

**Read the quantile against the declared bucket boundaries, not as a continuous number.** The
boundaries are pinned by the contract, and `histogram_quantile` interpolates linearly inside
whichever bucket the quantile falls in. A p99 reported as exactly a boundary value is that
boundary, not a measurement. The `15` boundary exists precisely because the gap between `10` and
`30` reported a true p99 of 11s as 20s; `tests/alerts` will carry that as a regression fixture
when these rules ship.

## Metrics absent

`PlatformServiceMetricsAbsent` is the alert that covers every other alert's blind spot. A service
that stops exposing produces no error ratio at all, so every burn-rate rule above goes **quiet**
rather than red. `platform_build_info` is the inventory that makes the silence visible.

```promql
count by (service, environment) (max_over_time(platform_build_info[1d]))
unless
count by (service, environment) (present_over_time(platform_build_info[3m]))
```

Check in this order:

1. **Is the service running?** `kubectl -n <ns> get pods -l app.kubernetes.io/name=<service>`.
   If the pods are gone or crash-looping, this is an outage, not a monitoring fault.
2. **Is it being scraped?** Check the `ServiceMonitor` selector still matches the Service labels.
   A renamed label silently drops the target.
3. **Did the service get deleted on purpose?** Then the alert is correct and will resolve on its
   own after 1d, when the `max_over_time` window forgets it. Do not silence it for longer than
   that.

**This alert can fire alongside a real outage.** Do not treat it as "just a scrape problem" until
step 1 says the pods are healthy.

## Budget window and retention

The budget window is **30 days**, and it is only as long as the data Prometheus still holds.
`platform-red-v1-budget` records it:

```promql
platform:request_error:budget_remaining30d{service="<service>", environment="<env>"}
```

`1` is an untouched budget, `0` is spent, below `0` is overspent. It divides
`platform:request_error:ratio_rate30d` by the 0.5% the objective allows; that ratio sums the
hourly `platform:request:rate1h` and `platform:request_error:rate1h` series over `[30d]`, so a
quiet hour weighs less than a busy one. `tests/alerts/platform-red-slo-budget.test.yaml` proves
the value and that data older than 30 days is left out.

The recorded series live in the same TSDB as everything else, so they are deleted by the same
retention. The window holds only because of the Prometheus settings in
`configuration/templates/helm-addons.tmpl`:

| Environment | `retention` | `retentionSize` | Volume | 30d window |
|---|---|---|---|---|
| homelab | `35d` | `80GB` | `100Gi` | whole, unless `retentionSize` binds first |
| localdev | `1d` | `4GB` | `5Gi` | **never whole**: Kind reads at most one day |

`retention` is 35d rather than 30d because Prometheus deletes whole blocks, and a block can span
up to 10% of the retention; at exactly 30d the oldest part of the window could already be gone.

**How much the window covers right now:**

```promql
(time() - prometheus_tsdb_lowest_timestamp_seconds) / 86400
```

Under 30 means every budget figure is over a shorter window than it claims. On a Prometheus
younger than 30 days that is expected and nothing to fix.

### Size retention truncated the window

`PrometheusRetentionTruncatesSLOWindow` fires when `retentionSize` deleted a block in the last
day **and** the oldest sample is now newer than 30 days. Time-based retention never fires it.

1. Check growth: `prometheus_tsdb_storage_blocks_bytes` over the last week, and which jobs add
   the most series (`topk(10, sum by (job) (scrape_samples_post_metric_relabeling))`).
2. Drop the cardinality first: a new high-cardinality label on one job is the usual cause, and
   fixing it at the source costs no disk.
3. Otherwise raise `retentionSize` and the volume together in `helm-addons.tmpl`. Keep
   `retentionSize` at or below 80% of the volume, since it also counts the WAL.

Until it is fixed, read `budget_remaining30d` as covering only the days the query above reports.
Do not use it to gate a release on its own.

## Quota is excluded from both sides

`code="quota"` is a principal correctly denied for exceeding a configured limit — the policy
working as designed, not the service failing. `metrics.v1.yaml` `sliExclusionRule` requires it to
be excluded from **both** the numerator and the denominator of the availability SLI.

If you are writing a new expression against this family, the shape is:

```promql
sum(rate(platform_request_duration_seconds_count{outcome="error", code!="quota"}[5m]))
/
sum(rate(platform_request_duration_seconds_count{code!="quota"}[5m]))
```

Excluding it from the numerator only is **worse than not excluding it at all**: the denials stay in
the population and are counted as *good* events. A service at 90 req/s healthy and 10 req/s
genuinely failing is at 10% errors and must page; one tenant retrying into its quota at 900 req/s
moves the numerator-only ratio to 1.0%, which clears neither paging tier. A noisy tenant would hide
someone else's outage. `tests/alerts` will carry both forms when these rules ship, so the
requirement has a failing counterexample rather than an argument.

`code!="quota"` also matches series carrying no `code` label at all, which is why successful
requests stay in the denominator.

## Probe traffic is excluded at the source

Kubelet liveness, readiness and startup probes, and scrapes of the exposition path, are **not
observed into this family** (`metrics.v1.yaml` `observation.excluded`). This is not something you
filter in a query — it is the producer's job, and a reserved route value that every expression had
to remember to exclude would be dropped in the first copy.

If you ever see probe traffic in these series, the SLI is wrong and the alerts under it cannot be
trusted. At an ordinary 10s probe period a homelab service runs roughly ten probes per user
request, so the measured error ratio is divided by about eleven: a user path failing 10% of the
time reads 0.91% and pages nobody. It also puts a floor under the objective — the highest error
ratio the family can express becomes 1/11 = 9.09%, so a service cannot measure below about 90.9%
availability however completely the user path fails, and "99.5%" stops being a statement about the
user. Treat it as a producer defect and fix it there.

## Canary analysis (`red-v1-canary`)

The `AnalysisTemplate` gates progressive rollouts on the same family. Three metrics run every
minute for eight intervals: absolute canary error ratio, canary error ratio *relative to stable*,
and canary p99 latency.

**An `AnalysisRun` that is `Inconclusive` pauses the rollout for a human — that is the design.**
It means the canary was not exercised enough to judge, not that it passed. Each query carries a
`+ 0 * scalar(sum(increase(...)) > 50)` term over the same population as the ratio it protects, so
a canary serving fewer than 50 requests in the window evaluates to NaN, both conditions go false,
and Argo Rollouts pauses rather than promoting a canary nobody exercised.

When one is inconclusive:

1. **Check the canary actually served traffic.** If it crashed before its first request, no canary
   series exist at all. The queries are wrapped in `scalar(...)` specifically so that case becomes
   a real NaN — an unwrapped expression returns an *empty result*, which `isNaN(result)` cannot
   see, and the rollout would promote a canary that never served a request.
2. **Check the traffic split actually routed to the canary.** A canary with no traffic and a
   healthy pod is a routing problem, not an application problem.
3. **Do not promote past an inconclusive run to unblock a release.** Send more traffic or extend
   the analysis window instead. The [emergency bypass](#emergency-bypass) is the one sanctioned
   exception.

`canary-error-ratio-vs-stable` exists so a service with a pre-existing error rate is still
deployable: the canary is allowed to be as bad as stable already is, and no worse. If the absolute
check fails but the relative check passes, the service was already breaching its objective before
this rollout — that is an availability incident, not a bad canary.

## Emergency bypass

If the canary analysis blocks a release that is itself the **fix** for an active incident, the
incident commander (the on-call, if nobody else has taken command) may authorize skipping it. This
is the only sanctioned way past an inconclusive or failed run:

```sh
kubectl argo rollouts promote <rollout> -n <namespace> --full
```

`--full` skips the remaining steps and analysis and moves all traffic to the new version. Record the
bypass on the incident issue with the alert that was firing, the release that was let through, and
who authorized it. The gate exists to stop risky changes during a burn, not to stop the recovery.

## After the incident

Write the postmortem blamelessly and file the tracked fix. If the alert fired and nobody could act
on it from this file, that is a defect in this file — fix it in the same change.
