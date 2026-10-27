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
| `cluster/topology.v1.yaml` | The control-plane member count, the etcd quorum formula, the `whole` and `survivable` health predicates, the gate each one belongs at and which gate a run enters at — shared by the Go CLI and `scripts/cp-storage-migrate.ts` so the rule exists once (ADR-035) |
| `status/status-page.v1.yaml` | The status page's back end -> UI HTTP surface: the polled document, the component taxonomy, how state and uptime are derived, and which upstream each derived field depends on — checked by `scripts/status-contract_test.ts` (ADR-051) |

Checked by `bun scripts/contract-check.ts` (`task contracts:check`), which fails on an invalid
subject, an unregistered guarantee, or a **breaking** change to a registered type that did not
take a new major version. See `docs/contracts/event-contract.md` for the reasoning and
`docs/project_notes/decisions.md` ADR-026 for the decision record.

`cluster/topology.v1.yaml` is checked by `scripts/topology-contract_test.ts` (runs in
`task test:scripts`), which asserts the contract is internally consistent — the worked quorum
table matches the stated formula, every permitted topology has a row, every condition is reached
by a predicate, `survivable` relaxes `whole` in exactly one way, every run shape enters at exactly
one entry point and ends whole, that the two senses of a missing member are defined once and each
has a condition that sees it, that the ordinary dead-target case refuses and names the procedure
that applies, and that both declared consumers exist at paths that hold what they claim to.
`evaluation.points` is a set of gates with exclusive entry, not a pipeline — a consumer that runs
all four in order refuses every legitimate resume (ADR-035, MCAA-404 ruling).

Those checks read the normative statement of each rule with parenthetical cross-references
stripped, and no normative statement may use the word "missing". Both are there because a token
search over whole rule text is satisfied by the explanatory prose after the statement, and a search
scoped to the statement is satisfied by a cross-reference inside it — a rule can then say the one
synonym this contract forbids and stay green (MCAA-483).

Conformance beyond that is per consumer, and `conformant` on each `consumers[]` entry states where
that consumer actually is. `runShapes` on each entry lists the run shapes it runs, and the entry
clause binds only a consumer that lists `resumed`. `full` means conformant on every clause that
binds it:

- **`homelab-cli` (Go) is conformant.** `internal/etcd` and `internal/topology` compute the quorum
  numbers from this file, select the entry point from the observed membership, and carry
  `TestConformsToExclusiveEntry`, `TestEntryRuleIsReadFromTheContract`, `TestEntryRuleFailsClosed`,
  `TestResumeRefusesASecondUnrepresentedAddress`, `TestResumeRefusesAStrangerMember` and
  `TestDeadDeclaredTargetRefusesAtPreflight`. `membership-accounts-for-expected` refuses on two
  observations and carries a test per observation: the two cancel in the arithmetic, so one case
  proves only whichever branch fires first. Its loader also refuses any contract naming a
  `health.conditions` entry it does not implement, so adding a condition here is a coordinated
  change across both, not an additive edit to this file.
- **`cp-storage-migrate` (TypeScript) is conformant.** `scripts/lib/topology-contract.ts` is its
  loader and predicate evaluator, and refuses an unimplemented condition the same way;
  `scripts/cp-storage-migrate-conformance_test.ts` walks every `quorum.table` row through the gate
  that consumes it and asserts each predicate refuses exactly the conditions the file composes into
  it. Its member set is etcd's own membership (`talosctl etcd members`), not the addresses it
  dialled. It runs the `fresh` run shape only — it stops a VM and starts it again and never removes
  a member, so no observation can select `resume` — and the entry clause, which binds a consumer
  running the destructive removal procedure, does not bind it.

Adding a `health.conditions` entry is therefore a change to **both** consumers: each loader refuses
to start on a contract naming a condition it cannot evaluate, which is deliberate — a guard that
skips the condition it did not recognise is worse than one that refuses.

**`cluster/` and `status/` have no compatibility gate, and the section below does not apply to
them yet.** `scripts/contract-check.ts` hard-codes `CONTRACTS_DIR = "contracts/events"` (L485), so
the frozen baseline, the breaking-change rule set and the `…v2` enforcement described under
*Changing something in here* cover `events/` **only**. Nothing machine-checks a rename, a removal
or a narrowed field in `cluster/topology.v1.yaml` or `status/status-page.v1.yaml`;
`topology-contract_test.ts` and `status-contract_test.ts` check that each file is internally
consistent, which is a different property — a contract can be perfectly self-consistent and still
have silently dropped a key a consumer reads. Until the baseline mechanism is extended, the rule
for both is **by review**: neither has a baseline, and once one has its first shipped consumer, any
rename or removal of a field takes `…v2.yaml` and is called out explicitly in the pull request.
Extending `CONTRACTS_DIR` to cover every subdirectory under `contracts/` is the durable fix and is
the preferred one; this paragraph is what stands in for it in the meantime, and it should be deleted
in the same change that lands the gate.

## Changing something in here

1. Additive change (new type, new optional attribute, new subject under an existing stream):
   edit the YAML, run `task contracts:check`, refresh the baseline with
   `bun scripts/contract-check.ts baseline --write`, commit both.
2. Breaking change (removing a type, removing/renaming a required attribute, narrowing a type,
   weakening a delivery guarantee): you must introduce `…​.v2` alongside `…​.v1` and keep v1
   published for at least one minor release of the platform. The checker enforces this; it does
   not ask whether you meant it.

There is no third option. A consumer you cannot see and cannot redeploy is assumed to exist.
