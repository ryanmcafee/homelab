# Platform contracts

The architecture baseline that this repository and the commercial control plane both build
against. One set of bones, not two copies: the moment homelab and enterprise diverge in
implementation for the same concern, the architecture has failed.

| Document | Decision record |
|---|---|
| [operator-model.md](operator-model.md) — reconciliation boundaries, CRD design, idempotency, what an operator must expose | ADR-025 |
| [event-contract.md](event-contract.md) — CloudEvents envelope, NATS subject taxonomy, delivery guarantee per path | ADR-026 |
| [sdk-boundary.md](sdk-boundary.md) — the shared SDK/API surface and how compatibility is tested | ADR-027 |
| [byo-extension-points.md](byo-extension-points.md) — bring-your-own cloud, key, identity centre, agent identity | ADR-028 |
| [fork-ability.md](fork-ability.md) — the fork-ability contract as a checkable rule | ADR-029 |
| [quality-gates.md](quality-gates.md) — contract tests, schema compatibility, upgrade and rollback | ADR-030 |

The ADRs live in [`docs/project_notes/decisions.md`](../project_notes/decisions.md), the
repository's existing decision record. These documents carry the normative detail an ADR
deliberately leaves out; the machine-checkable artifacts live in [`contracts/`](../../contracts).

## Status

Baseline as of 2026-09-25. The operator, SDK and BYO-* seams described here are **design**,
not shipped code — nothing in `contracts/events/` is published on a running bus yet. They are
written before implementation on purpose (contract before implementation); the first
implementation that disagrees with a document here changes the document and its ADR in the
same pull request, or it is not merged.
