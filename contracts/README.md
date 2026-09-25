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

Checked by `bun scripts/contract-check.ts` (`task contracts:check`), which fails on an invalid
subject, an unregistered guarantee, or a **breaking** change to a registered type that did not
take a new major version. See `docs/contracts/event-contract.md` for the reasoning and
`docs/project_notes/decisions.md` ADR-026 for the decision record.

## Changing something in here

1. Additive change (new type, new optional attribute, new subject under an existing stream):
   edit the YAML, run `task contracts:check`, refresh the baseline with
   `bun scripts/contract-check.ts baseline --write`, commit both.
2. Breaking change (removing a type, removing/renaming a required attribute, narrowing a type,
   weakening a delivery guarantee): you must introduce `…​.v2` alongside `…​.v1` and keep v1
   published for at least one minor release of the platform. The checker enforces this; it does
   not ask whether you meant it.

There is no third option. A consumer you cannot see and cannot redeploy is assumed to exist.
