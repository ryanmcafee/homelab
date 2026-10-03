# contracts/

The machine-checkable half of the platform architecture baseline. Everything in here is
**normative**: it is the shared surface that this repository and the commercial control plane
both build against, and it is checked in CI rather than agreed in prose.

| Path | What it fixes |
|---|---|
| `events/envelope.v1.schema.json` | The CloudEvents envelope profile every event on the bus must satisfy |
| `events/subjects.v1.yaml` | The NATS subject grammar, the stream set, and the delivery guarantee of each path |
| `events/registry.v1.yaml` | Every registered event type: version, direction, subject, schema, ordering and delivery guarantee |
| `events/registry.v1.baseline.json` | The frozen compatibility baseline the checker diffs against |
| `cluster/topology.v1.yaml` | The control-plane member count, the etcd quorum formula, the `whole` and `survivable` health predicates and the gate each one belongs at — shared by the Go CLI and `scripts/cp-storage-migrate.ts` so the rule exists once (ADR-035) |
| `status/status-page.v1.yaml` | The status page's back end -> UI HTTP surface: the polled document, the component taxonomy, how state and uptime are derived, and which upstream each derived field depends on — checked by `scripts/status-contract_test.ts` (ADR-051) |
| `observability/metrics.v1.yaml` | The RED metric shape every first-party control-plane service emits: the one histogram, its pinned buckets, the required label set including `tenant`, the cardinality ceilings and what counts as an error |

Checked by `bun scripts/contract-check.ts` (`task contracts:check`), which fails on an invalid
subject, an unregistered guarantee, or a **breaking** change to a registered type that did not
take a new major version. See `docs/contracts/event-contract.md` for the reasoning and
`docs/project_notes/decisions.md` ADR-026 for the decision record.

`cluster/topology.v1.yaml` is checked by `scripts/topology-contract_test.ts` (runs in
`task test:scripts`), which asserts the contract is internally consistent — the worked quorum
table matches the stated formula, every permitted topology has a row, every condition is reached
by a predicate, `survivable` relaxes `whole` in exactly one way, and both declared consumers
exist. Each consumer additionally carries its own conformance test asserting that its
implementation computes the numbers this file pins; that is what keeps a Go implementation and a
TypeScript one from drifting into two different safety rules.

`observability/metrics.v1.yaml` is checked by `scripts/metrics-contract_test.ts` (runs in
`task test:scripts`), which asserts the same class of internal consistency — bucket boundaries and
their `le` strings are the same list, the quoted cardinality arithmetic fits the ceiling next to
it, no label is both required and forbidden, the tenancy vocabulary is the event envelope's rather
than a second one, and no query in `docs/contracts/metric-contract.md` names a label the contract
does not declare. Producer-side conformance — a service's `/metrics` actually having this shape —
is a level-1 check named in the contract's `enforcement` section and **not implemented**; the
contract says so itself rather than implying a gate that is not running.

**`cluster/`, `status/` and `observability/` have no compatibility gate, and the section below does
not apply to them yet.** `scripts/contract-check.ts` hard-codes `CONTRACTS_DIR = "contracts/events"`
(L485), so the frozen baseline, the breaking-change rule set and the `…v2` enforcement described
under *Changing something in here* cover `events/` **only**. Nothing machine-checks a rename, a
removal or a narrowed field in `cluster/topology.v1.yaml`, `status/status-page.v1.yaml` or
`observability/metrics.v1.yaml`; `topology-contract_test.ts`, `status-contract_test.ts` and
`metrics-contract_test.ts` check that each file is internally consistent, which is a different
property — a contract can be perfectly self-consistent and still have silently dropped a key a
consumer reads. Until the baseline mechanism is extended, the rule for all three is **by review**:
none has a baseline, and once one has its first shipped consumer, any rename or removal of a field
takes `…v2.yaml` and is called out explicitly in the pull request. `metrics.v1.yaml` carries its
own `compatibility` section stating which changes are breaking for a metric — the rules differ from
the event ones in one direction that matters, since adding a label is additive in a JSON schema and
breaking in a metric family. Extending `CONTRACTS_DIR` to cover every subdirectory under
`contracts/` is the durable fix and is the preferred one; this paragraph is what stands in for it in
the meantime, and it should be deleted in the same change that lands the gate.

## Changing something in here

1. Additive change (new type, new optional attribute, new subject under an existing stream):
   edit the YAML, run `task contracts:check`, refresh the baseline with
   `bun scripts/contract-check.ts baseline --write`, commit both.
2. Breaking change (removing a type, removing/renaming a required attribute, narrowing a type,
   weakening a delivery guarantee): you must introduce `…​.v2` alongside `…​.v1` and keep v1
   published for at least one minor release of the platform. The checker enforces this; it does
   not ask whether you meant it.

There is no third option. A consumer you cannot see and cannot redeploy is assumed to exist.
