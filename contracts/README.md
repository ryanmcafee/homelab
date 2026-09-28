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
| `*/shape.baseline.json` | The frozen structural baseline of every document in that directory — one per directory, generated, never hand-edited (ADR-048) |

Checked by `bun scripts/contract-check.ts` (`task contracts:check`), which fails on an invalid
subject, an unregistered guarantee, or a **breaking** change to a registered type that did not
take a new major version. See `docs/contracts/event-contract.md` for the reasoning and
`docs/project_notes/decisions.md` ADR-026 for the decision record.

The gate has two legs and they know different amounts about what they read.

The **event leg** applies to `events/` alone and speaks that domain's vocabulary: subject grammar,
delivery guarantee, stream filter, envelope attribute, payload property. `registry.v1.baseline.json`
is its frozen artifact.

The **structural leg** (ADR-048) applies to **every** directory here, that one included. It reads
any contract document — bespoke YAML, JSON Schema, OpenAPI — as a tree of fields and rejects the
differences that break a consumer whatever the document means. It is why `cluster/` no longer sits
outside the gate and why a directory added next cannot: a contract directory with no
`shape.baseline.json`, or a document that baseline does not pin, is itself a violation, so the scope
extends by failing rather than by someone remembering to widen a constant.

| Rule | Fires when |
|---|---|
| `contract-field-removed` | a pinned path is gone. A rename is this rule plus an unremarked addition |
| `contract-entry-removed` | an entry of a list is gone, named by the `id`/`name`/`key`/`type` a consumer selects on |
| `contract-field-retyped` | the kind at a pinned path changed, a scalar list becoming a list of objects included |
| `contract-list-member-removed` | a declared set lost a member, so a value it used to permit no longer is |
| `contract-required-added` | a `required` list grew: every producer that validated now fails |
| `contract-required-removed` | a `required` list shrank: every consumer that relied on the field being present now fails |
| `contract-bound-tightened` | a `min…` rose or a `max…` fell, rejecting a value that used to validate |
| `contract-baseline-missing` | a contract directory has no `shape.baseline.json`, so no rule ran against it |
| `contract-document-unpinned` | a document is not in its directory's baseline, so no rule ran against it |
| `contract-document-removed` | a published contract document was withdrawn rather than superseded |

Two things the structural leg does **not** decide, stated here rather than left to be discovered.
A scalar value that is not a direction-classified numeric bound — `quorum.formula` becoming a
different expression, `evaluation.onIndeterminate` flipping from `unsafe` to `safe` — is breaking
and no rule above rejects it; what happens instead is that the value is pinned, the baseline stops
matching, the in-sync test in `scripts/contract-check_test.ts` fails, and the change is unmissable
in review rather than silently green. A duration written as a string (`max_age: 168h`) is not
direction-classified at all. Both are the named residual of MCAA-431.

An internal-consistency test and the compatibility gate check different properties, and every
contract here needs both. `cluster/topology.v1.yaml` is additionally checked by
`scripts/topology-contract_test.ts` (runs in `task test:scripts`), which asserts that the contract
agrees with itself — the worked quorum table matches the stated formula, every permitted topology has
a row, every condition is reached by a predicate, `survivable` relaxes `whole` in exactly one way,
and both declared consumers exist. Each consumer additionally carries its own conformance test
asserting that its implementation computes the numbers this file pins; that is what keeps a Go
implementation and a TypeScript one from drifting into two different safety rules. A contract can
satisfy all of that and still have silently dropped a key a consumer reads, which is the gate's job
and not the test's.

## Changing something in here

1. Additive change (new type, new optional attribute, new subject under an existing stream, a new
   field on any contract): edit the document, run `task contracts:check`, refresh the baselines with
   `bun scripts/contract-check.ts baseline --write`, commit both.
2. Breaking change (removing a type, removing/renaming a required attribute, narrowing a type,
   weakening a delivery guarantee, and every rule in the table above): you must introduce `…​.v2`
   alongside `…​.v1` and keep v1 published for at least one minor release of the platform. The
   checker enforces this; it does not ask whether you meant it. Regenerating the baseline does not
   clear these — that is what separates them from an additive change.

There is no third option. A consumer you cannot see and cannot redeploy is assumed to exist.

## Adding a contract

Create `contracts/<area>/<name>.v1.yaml`, run `bun scripts/contract-check.ts baseline --write` to
freeze its shape, and commit the generated `shape.baseline.json` beside it. Add the
internal-consistency test the contract needs, add a row to the table at the top of this file, and
record the decision as an ADR. Until the baseline exists the gate fails with
`contract-baseline-missing`, which is deliberate: a contract nobody froze is a contract nothing is
checking.
