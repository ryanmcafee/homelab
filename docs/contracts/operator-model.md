# The operator model

Normative. Decision record: ADR-024 in [`docs/project_notes/decisions.md`](../project_notes/decisions.md).

Every stateful platform capability — on the homelab cluster and in the commercial control
plane — is delivered by a Kubernetes operator reconciling a CRD. Not by a bespoke service
holding state, not by a workflow that runs once and hopes. This document says what that
obligates.

## 1. Reconciliation boundaries

**One controller owns one resource's `status` and nothing else's.** Two controllers writing
the same `status` is the defect that produces flapping, and no amount of retry logic fixes it.

Boundaries are drawn along *failure domains*, not along org charts:

| Operator | Owns (spec → status) | May read | Must not write |
|---|---|---|---|
| `workload-operator` | `Workload`, `WorkloadRelease` | `Application` (ArgoCD), `Deployment` | ArgoCD resources |
| `infra-operator` | `NodePool`, `StorageClaim` | `Node`, `PersistentVolume` | Workload resources |
| `identity-broker` | `Principal`, `AgentIdentity` | `OnePasswordItem`, `ExternalSecret` | Any application secret directly |
| `gitops-bridge` | `SyncObservation` | `Application`, `AppProject` | `Application.spec` |

The bridge pattern in the last row is deliberate: ArgoCD already owns `Application`, so the
platform observes it into its own CRD rather than contending for it. **When an upstream
operator already owns a resource, wrap it; never co-own it.**

## 2. CRD design

- **Spec is desired state, declared by a human or an API call. Status is observed state,
  written only by the owning controller.** A field that a user sets and the controller also
  overwrites belongs in two fields, not one.
- **`status.conditions` follows the Kubernetes convention** (`type`, `status`, `reason`,
  `message`, `lastTransitionTime`, `observedGeneration`). Every operator publishes at least
  `Ready`. Anything a human or a golden path waits on is a condition, not a log line.
- **`status.observedGeneration` is mandatory.** Without it a reader cannot distinguish
  "reconciled and healthy" from "not looked at yet", and every wait loop becomes a guess.
- **Every CRD is served at `v1alpha1` → `v1beta1` → `v1` with a conversion webhook from the
  moment a second version exists.** Storage version changes are a migration, documented as one.
- **No field is a free-form string where an enum will do**, and no enum is extended by
  removing a value. Enum extension is additive; removal is a new API version.
- **Defaulting happens in the API server via schema defaults**, not in the controller. A
  controller-side default is invisible to `kubectl get -o yaml` and to every other client.
- **No operator embeds an operator-specific hostname, cloud account, cluster name or email.**
  Those arrive from configuration (see [fork-ability.md](fork-ability.md)).

## 3. Idempotency requirements

An operator must converge from **any** starting state, repeatedly, without surprise. In
practice that means:

1. **Reconcile is a pure function of observed state.** It reads the world, computes the
   desired world, and writes the difference. It must never depend on having seen the previous
   event, because it will be restarted mid-stream and it will be replayed.
2. **Writes use server-side apply with a stable field manager.** Not read-modify-write, which
   silently clobbers fields the operator does not know about.
3. **Running reconcile twice in a row with no intervening change produces zero writes.** This
   is testable and is a required test for every operator (see [quality-gates.md](quality-gates.md)).
4. **External side effects carry an idempotency key derived from
   `(uid, generation)`** — never from a timestamp, a random value, or a retry counter.
5. **Deletion goes through a finalizer** that is removed only after the external effect is
   confirmed gone. A finalizer with no timeout and no escape hatch is an outage; every
   finalizer documents how an operator clears it by hand.
6. **Events are a hint, never the carrier of state.** Losing an event costs latency, never
   correctness. A periodic resync (default 10 minutes, configurable) is the floor; the event
   path only makes convergence faster. This is what makes the at-least-once bus in
   [event-contract.md](event-contract.md) safe to build on.

## 4. What an operator must expose to be observable

Not optional, and checked at review:

- **Metrics** (`/metrics`, Prometheus): `controller_runtime_reconcile_total{result}`,
  `controller_runtime_reconcile_errors_total`, `controller_runtime_reconcile_time_seconds`,
  `workqueue_depth`, `workqueue_unfinished_work_seconds`, and one gauge per CRD counting
  resources by `Ready` condition. A `ServiceMonitor` ships with the operator's chart.
- **Traces**: every reconcile is a span, linked by `correlationid` to the event or API call
  that triggered it. OTLP to the gateway collector (ADR-021).
- **Kubernetes Events** on the resource for state transitions a human would ask about —
  not for every loop iteration.
- **Structured logs** with the resource's namespace/name and `observedGeneration` on every
  line.
- **An SLO**: reconcile-to-`Ready` latency and reconcile error rate, with an owner. An
  operator with no SLO has no definition of "working", and the SRE & Observability Engineer
  owns the target.

## 5. Blast radius

Stated per operator, in its own README, before it merges: what breaks when the operator is
down, and how far the failure travels. The baseline expectation is that an operator being
down freezes change but does not break running workloads — reconciliation stops, existing
Deployments keep serving. An operator that can take down running traffic when *it* fails is a
design defect and needs an explicit, argued exception.
