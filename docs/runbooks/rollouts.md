# Progressive delivery (Argo Rollouts)

What each `homelab-progressive-delivery` alert means and what to do about it.
The delivery model itself (canary steps, the `canary-http-health` analysis,
automated rollback) is in [docs/progressive-delivery.md](../progressive-delivery.md).

## Where the signal comes from

The argo-rollouts controller exposes `rollout_info` and `analysis_run_info` on
its metrics Service (port 8090, port name `metrics`). Both are gauges that are
always 1 and carry exactly one `phase` label value per object, so a phase change
is one series ending and another starting.

`rollout_info{phase}` is the controller's own enum, not the Rollout's
`status.phase`: `Completed`, `Progressing`, `Paused`, `Timeout`, `Error`,
`InvalidSpec`, `Abort` (verified against argo-rollouts v1.10.0,
`controller/metrics/rollouts.go`). `analysis_run_info{phase}` is the
AnalysisRun's `status.phase`: `Pending`, `Running`, `Successful`, `Failed`,
`Error`, `Inconclusive`.

The scrape is the `argo-rollouts` ServiceMonitor in the `monitoring` namespace,
rendered by `charts/prometheus-config` at sync wave 8. It cannot live in the
argo-rollouts Application: that syncs at wave 2, before the
`monitoring.coreos.com` CRDs exist, and a ServiceMonitor there fails the first
sync of a fresh cluster. `honorLabels: true` keeps each series' `namespace` as
the watched Rollout's namespace rather than `argo-rollouts`.

Every rule renders when `argo-rollouts.enabled` and
`argo-rollouts.metrics.enabled` are both true, in localdev and homelab alike.
The fixtures are `tests/alerts/rollouts.test.yaml` (`task test:alerts`).

## Alerts

Per-Rollout alerts are `severity: info`: an abort means the stable ReplicaSet
kept serving, which is the canary contract working, so nobody is paged. The
fleet-wide and blindness alerts are `severity: warning`.

### HomelabRolloutAborted

`max by (namespace, name) (rollout_info{phase="Abort"}) == 1` for 5m.

The canary analysis failed and the controller scaled the canary to zero. The
previous revision is still serving; the new one did not land, and the controller
will not retry the same image on its own.

1. `kubectl -n <namespace> describe rollout <name>`: the status message names the
   failed step and AnalysisRun.
2. `kubectl -n <namespace> get analysisrun` and `kubectl describe` the newest
   one: `canary-http-health` reports which probe failed.
3. `kubectl -n <namespace> logs job/<analysisrun>-...` shows the HTTP status the
   probe saw from the canary Service.
4. Fix the image and push a new revision. `kubectl argo rollouts retry rollout
   <name> -n <namespace>` re-runs the same revision only if the failure was
   transient.

### HomelabRolloutProgressDeadlineExceeded

`max by (namespace, name) (rollout_info{phase="Timeout"}) == 1` for 15m.

`progressDeadlineSeconds` elapsed before the new ReplicaSet became available.
Nothing failed the analysis and nothing promoted: usually the canary pods never
reached Ready.

1. `kubectl -n <namespace> get rs,pod -l app.kubernetes.io/name=<name>`
2. `kubectl -n <namespace> describe pod <canary pod>`: image pull, scheduling or
   readiness failures show in the events.
3. Fix the cause, then `kubectl argo rollouts retry rollout <name> -n <namespace>`
   or roll forward with a new revision.

### HomelabRolloutStuckPaused

`max by (namespace, name) (rollout_info{phase="Paused"}) == 1` for 1h.

A paused Rollout is exempt from `progressDeadlineSeconds`, so it never reaches
`Timeout`: without this alert an unpromoted canary waits forever in silence. An
`Inconclusive` analysis also pauses the Rollout and lands here.

1. `kubectl argo rollouts get rollout <name> -n <namespace>` shows the step it is
   paused on and why.
2. If the canary is good: `kubectl argo rollouts promote <name> -n <namespace>`.
3. If it is not: `kubectl argo rollouts abort <name> -n <namespace>`.

### HomelabAnalysisRunErrored

`analysis_run_info{phase="Error"}` that was not in `Error` an hour earlier, for 5m.

The analysis could not take its measurements, so the canary was rolled back
because the gate was blind, not because the revision was bad. A `Failed` run is
deliberately not alerted here: that is the gate working and it already surfaces
as `HomelabRolloutAborted`. Finished runs are kept as history, which is why the
rule compares against an hour ago; it resolves on its own once the run is old.

1. `kubectl -n <namespace> describe analysisrun <name>`: the measurement's
   `message` names the error.
2. For `canary-http-health`, the measurement is a Job: check it was created and
   scheduled (`kubectl -n <namespace> get job,pod`), and that its image pulls.
3. Fix the template (`charts/argo-rollouts-config`) or the cluster condition
   before retrying the revision; retrying an errored gate proves nothing.

### HomelabRolloutsNotProgressing

`count(rollout_info{phase=~"Abort|Error|InvalidSpec|Timeout"}) / count(rollout_info) > 0.5`
with at least two Rollouts, for 15m.

More than half the fleet is stuck at once. That is not N independent bad
revisions: suspect something shared, such as a bad base image, a broken
`canary-http-health` template, or a sick controller. One series, with no
`namespace` or `name`, however large the fleet. The floor of two Rollouts keeps a
fork that runs a single canary from firing it on every abort.

1. `kubectl argo rollouts list rollouts -A` to see which are stuck and in which
   phase.
2. `kubectl -n argo-rollouts logs deploy/argo-rollouts` for controller errors.
3. Check the shared template: `kubectl get clusteranalysistemplate canary-http-health -o yaml`.

### HomelabRolloutMetricsUnavailable

`absent(up{job="argo-rollouts", namespace="argo-rollouts"} == 1)` for 15m.

Every other alert in this group reads a series the controller produces, so while
it is not scraped an aborted deploy is silent again. This covers both a failing
scrape and a target that has gone entirely.

1. `kubectl -n argo-rollouts get deploy,pod,svc -l app.kubernetes.io/name=argo-rollouts`
2. `kubectl -n monitoring get servicemonitor argo-rollouts`: it selects the
   Service by `app.kubernetes.io/name=argo-rollouts` and
   `app.kubernetes.io/component=rollouts-controller` on port name `metrics`. A
   chart bump that renames either breaks the scrape.
3. Prometheus UI, Status -> Targets, `serviceMonitor/monitoring/argo-rollouts`.
