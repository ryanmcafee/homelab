# Platform RED SLO: burn-rate alerts and the canary analysis

Every alert in the `platform-red-v1-slo` rule group annotates this file. The group covers two
objectives over the `platform_request_duration_seconds` family defined by
`contracts/observability/metrics.v1.yaml`:

| Objective | SLI | Target | Window |
|---|---|---|---|
| `platform-http-availability` | non-quota errors / non-quota requests, `kind="http"` | 99.5% | 30d |
| `platform-http-latency` | successful requests completing under 250ms, `kind="http"` | 99% | 30d |

A 99.5% availability objective spends its whole 30-day budget in 3.6 hours at a 14.4x burn rate,
which is why the fast tier pages and the slow tier does not.

> **Status: the rules are not deployed yet.** No service emits
> `platform_request_duration_seconds`, so nothing in this file can fire today. It exists first
> because these alerts do not ship without it. The alert definitions and their promtool fixtures
> live on MCAA-277 until a conformant producer exists.

## Which alert fired

| Alert | Severity | Means | Go to |
|---|---|---|---|
| `PlatformRequestErrorBudgetBurningFast` | critical | 14.4x or 6x availability burn, confirmed on a short and a long window | [Availability burn](#availability-burn) |
| `PlatformRequestErrorBudgetBurningSlow` | warning | 3x or 1x burn over days | [Availability burn](#availability-burn) |
| `PlatformRequestLatencyBudgetBurningFast` | critical | 14.4x latency burn against 99% under 250ms | [Latency burn](#latency-burn) |
| `PlatformServiceMetricsAbsent` | critical | a service that was exposing RED metrics stopped | [Metrics absent](#metrics-absent) |

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
changes(platform_build_info{service="<service>", environment="<env>"}[1h])
```

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
`30` reported a true p99 of 11s as 20s; `tests/alerts` carries that as a regression fixture.

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
someone else's outage. `tests/alerts` carries both forms so the requirement has a failing
counterexample rather than an argument.

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
   the analysis window instead.

`canary-error-ratio-vs-stable` exists so a service with a pre-existing error rate is still
deployable: the canary is allowed to be as bad as stable already is, and no worse. If the absolute
check fails but the relative check passes, the service was already breaching its objective before
this rollout — that is an availability incident, not a bad canary.

## Emergency bypass

If the error budget gate blocks a release that is itself the **fix** for an active incident, ship
it. Record the bypass on the incident issue with the alert that was firing and the release that
was let through. The gate exists to stop risky changes during a burn, not to stop the recovery.

## After the incident

Write the postmortem blamelessly and file the tracked fix. If the alert fired and nobody could act
on it from this file, that is a defect in this file — fix it in the same change.
