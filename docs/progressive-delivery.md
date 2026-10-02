# Progressive delivery: Argo Rollouts canary + automated rollback

The golden path does not cut a Deployment over in one step. A workload declared as a
`Rollout` sends the new revision to half the replicas, an analysis probes it, and the
controller either promotes it or aborts back to the stable ReplicaSet on its own. No
operator, no `kubectl rollout undo`.

| Application | Chart (`configuration/versions.yaml`) | Wave | Notes |
|---|---|---|---|
| `argo-rollouts` | `argo-rollouts` (`charts.argo-rollouts`) | 2 | controller and the `Rollout` / `AnalysisTemplate` / `ClusterAnalysisTemplate` / `AnalysisRun` / `Experiment` CRDs; metrics Service on 8090, no dashboard |
| `argo-rollouts-config` | `charts/argo-rollouts-config` | 3 | the `canary-http-health` ClusterAnalysisTemplate every canary references |

Both are enabled in every set, Kind included, because the rollback behaviour is proven on
the Kind loop at level 2 (`tests/e2e/argo-rollouts`).

## The canary contract

```mermaid
sequenceDiagram
    participant A as ArgoCD
    participant R as Rollouts controller
    participant C as canary Service
    participant J as probe Job
    A->>R: Rollout spec, new pod template
    R->>R: setWeight 50 - canary ReplicaSet to half the replicas
    R->>C: pin canaryService selector to the canary pod-template-hash
    R->>J: AnalysisRun - canary-http-health
    J->>C: curl -fsS http://<canary>/healthz (3 measurements, 15s apart)
    alt every measurement exits 0
        J-->>R: AnalysisRun Successful
        R->>R: setWeight 100 - canary becomes stable
    else any measurement exits non-zero
        J-->>R: AnalysisRun Failed
        R->>R: abort - scale the canary to zero, stable keeps serving
    end
```

Steps, in order: `setWeight: 50` -> `analysis` -> `setWeight: 100`.

## Delivery and ordering guarantees

- **Steps are strictly ordered and sequential.** The analysis never starts before the canary
  pods are available, and `setWeight: 100` never runs before the analysis returns Successful.
- **The verdict is at-least-once probing, not a single sample.** `count: 3`, `interval: 15s`,
  `initialDelay: 10s`. Each measurement is an independent Job; a retried or duplicated Job is
  harmless because the probe is a read.
- **`failureLimit: 0` — the first failed measurement aborts.** A canary that cannot serve its
  own health endpoint has nothing to average out. The cost is that a genuinely flaky network
  aborts a good revision; the alternative is shipping a broken one.
- **Rollback is not a redeploy.** The stable ReplicaSet was never scaled to zero, so aborting
  is a scale-down of the canary. There is no window in which no pod serves.
- **Promotion is not atomic across pods.** Between `setWeight: 50` and `setWeight: 100` both
  revisions serve the stable Service. A revision that cannot coexist with its predecessor
  needs `blueGreen`, not `canary`.
- **An aborted Rollout stays `Degraded` with `status.abort: true`** until a new revision is
  pushed. It does not retry the same image.

## The analysis metric and its source

`canary-http-health` (`charts/argo-rollouts-config/templates/canary-http-health.yaml`) is the
only analysis the golden path ships. Its source is an **in-cluster HTTP probe Job**: a
`curlimages/curl` pod that runs `curl -fsS` against the canary Service and hands its exit code
to the controller. A refused connection, a timeout or any status >= 400 fails the measurement.

It deliberately does **not** query Prometheus. A scrape has to land inside the analysis window
for a Prometheus verdict to mean anything, which makes the rollback non-deterministic in CI,
and it would make canary behaviour depend on a metrics pipeline a fork may not run. The Job
carries no hostname, cluster name, registry or account: the Service DNS name and namespace
arrive as analysis arguments, and the image tag comes from `configuration/versions.yaml`.

Arguments: `service` (the canary Service), `namespace` (usually
`valueFrom.fieldRef: metadata.namespace`), `port` (default `80`), `path` (default `/healthz`).

## The shipped canary

`paperclip-exporter` (`charts/paperclip/templates/exporter.yaml`) is the first golden-path
workload on this path — a real workload, scraped by a ServiceMonitor and documented in
[runbooks/paperclip-agents.md](runbooks/paperclip-agents.md), not a sample. It declares
`canaryService: paperclip-exporter-canary` and `stableService: paperclip-exporter`, and its
analysis step probes port 9464.

The canary Service is deliberately not labelled `app.kubernetes.io/name: paperclip-exporter`:
the ServiceMonitor selects Services by that label and would otherwise scrape the canary pods
as a second source of the same series.

## Watching a rollout

```bash
kubectl argo rollouts get rollout paperclip-exporter -n paperclip --watch
kubectl get rollout paperclip-exporter -n paperclip -o jsonpath='{.status.phase} {.status.abort}{"\n"}'
kubectl get analysisrun -n paperclip -o custom-columns=NAME:.metadata.name,PHASE:.status.phase
kubectl describe rollout paperclip-exporter -n paperclip   # events carry the abort reason
```

An abort reads `Rollout aborted update to revision N: Metric "canary-http-health" assessed
Failed` in the Rollout's events.

## Proof

`tests/e2e/argo-rollouts/chainsaw-test.yaml` runs on the Kind loop at level 2
(`task verify LEVEL=2`, `task test:e2e -- --test-dir tests/e2e/argo-rollouts`). It asserts the
shipped `Rollout/paperclip-exporter` is wired to `canary-http-health`, then drives a fixture
Rollout in the chainsaw namespace through both outcomes: a healthy revision promoted after a
`Successful` AnalysisRun, and a revision whose pods are Ready but silent on the Service port
aborted by a `Failed` AnalysisRun, with the stable Service still answering 200.

The failure case is exercised, not read off the config: the broken revision listens on 8081
while the Services target 8080, so its pods pass their own readiness probe and still fail the
canary probe.

## Giving a new workload a canary

1. Change `kind: Deployment` to `apiVersion: argoproj.io/v1alpha1`, `kind: Rollout`. Everything
   under `spec.template` stays as it was.
2. Add a second Service for the canary, selecting the same pods, **without** any label a
   ServiceMonitor selects on.
3. Add the strategy:

   ```yaml
   strategy:
     canary:
       canaryService: <name>-canary
       stableService: <name>
       steps:
         - setWeight: 50
         - analysis:
             templates:
               - templateName: canary-http-health
                 clusterScope: true
             args:
               - name: service
                 value: <name>-canary
               - name: namespace
                 valueFrom:
                   fieldRef:
                     fieldPath: metadata.namespace
               - name: port
                 value: "<service port>"
         - setWeight: 100
   ```

4. The owning Application must sync after wave 3. Level 0 (`gitops/<env>/crd-order`) fails
   otherwise — `tests/gitops/crd-providers.yaml` maps the progressive-delivery kinds to the
   `argo-rollouts` Application.
