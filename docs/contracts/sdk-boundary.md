# The shared SDK and API boundary

Normative. Decision record: ADR-026 in [`docs/project_notes/decisions.md`](../project_notes/decisions.md).

This is the surface where homelab and the commercial platform meet. It exists so that there is
exactly one implementation of each shared concern. **The moment the two surfaces implement the
same concern twice, the architecture has failed** — and the way that happens in practice is
never a decision, it is a small convenience taken twice.

## 1. What is shared, and what is not

| Layer | Homelab | Enterprise | Shared? |
|---|---|---|---|
| Event envelope, subject taxonomy, registry | same | same | **yes — `contracts/events/`** |
| CRDs and operator reconcile logic | same | same | **yes — one operator image** |
| Platform SDK (publish/subscribe, CRD clients, config, identity) | same | same | **yes — one package** |
| Platform API (HTTP + request/reply) | same handlers | same handlers | **yes — one OpenAPI document** |
| Identity provider, cloud, KMS, secret store | operator's choice | customer's choice | no — a [BYO-* seam](byo-extension-points.md) |
| Tenancy | single tenant `local` | many | no — same code path, different cardinality |
| Billing, entitlement, support tooling | absent | present | no — enterprise-only, layered *above* the SDK, never branching inside it |

The right-hand column is the test. If a concern is in the top block and someone proposes a
second implementation for one surface, that is the defect this document exists to prevent.

## 2. API-first: the contract exists before the code

For any capability crossing a service or trust boundary, this order is required and is
enforced at review:

1. **The contract lands first** — an OpenAPI 3.1 document for HTTP, a JSON Schema plus a
   registry entry for events, a CRD schema for a Kubernetes surface.
2. **Contract tests land with it**, and they fail, because there is no implementation.
3. **Implementation lands** and turns them green.

A pull request that introduces an endpoint or an event type and its implementation with no
published contract is rejected regardless of how good the implementation is. "The code is the
contract" means every consumer reads the code, and every refactor is a breaking change.

Generated artifacts follow from the contract, never the reverse: TypeScript types are
generated from OpenAPI and from the event JSON Schemas at build time. A hand-written type that
duplicates a generated one is a fork waiting to happen.

## 3. SDK shape

One package, consumed identically by a homelab script and by an enterprise control-plane
service. Its surface is deliberately small:

- **`events`** — `publish(event)`, `subscribe(subject, handler)`, `request(subject, body)`.
  Sets `id`, `time`, `source`, `traceparent`, `tenant` and the `Nats-Msg-Id` header; overwrites
  `sequence` from the PubAck; validates against the envelope schema **before** publish and
  **after** receive. Validation on both sides is not redundant — the producer-side check keeps
  bad data off the bus, the consumer-side check keeps a bad producer from becoming your bug.
- **`resources`** — typed clients for the platform CRDs, generated from the CRD schemas.
- **`config`** — resolves configuration through the fork-ability rules in
  [fork-ability.md](fork-ability.md). No `process.env` reads scattered through call sites.
- **`identity`** — obtains and attaches the caller's principal. Never a place where a specific
  identity provider appears; that is a [BYO seam](byo-extension-points.md).

Each of the four is a seam, not a utility grab-bag. `utils` is not an SDK module, and a
function with no home usually means a missing seam.

## 4. Compatibility testing

Three gates, all runnable locally and all required in CI:

| Gate | What it proves | How |
|---|---|---|
| **Event contract** | The registry is internally consistent and no change breaks a published type | `task contracts:check` — [`scripts/contract-check.ts`](../../scripts/contract-check.ts), covered by `scripts/contract-check_test.ts` |
| **HTTP contract** | The served API still satisfies the OpenAPI document, and the new document is backward-compatible with the previous release's | Schema diff against the last released document; additive-only within a major |
| **CRD contract** | Stored objects still round-trip through the new schema, and conversion webhooks work in both directions | Apply the previous version's fixtures against the new CRD |

The event gate is the model for the other two: a frozen baseline in the repository, a diff
against it, and a rule set that names *which* differences are breaking rather than asking a
reviewer to notice. See [quality-gates.md](quality-gates.md).

## 5. Versioning

- HTTP: `/api/v1/…`. A breaking change is `/api/v2/…` served **alongside** v1.
- Events: the major is in the `type` and the subject.
- CRDs: Kubernetes API versions with a conversion webhook.
- SDK: semver, where a major bump is permitted only when the underlying contract already
  published a new major. The SDK cannot break compatibility on its own — if it could, the
  contract would not be the source of truth.

**Assume a consumer you cannot see and cannot redeploy.** On the homelab surface that consumer
is a stranger's fork; on the enterprise surface it is a customer's integration. Neither will
be there to notice your migration note.

## 6. Blast radius

The SDK is a library, so a bad release does not take down a running system — it takes down the
next deploy of everything that consumes it. That makes the SDK the single highest-fan-out
artifact in the platform, and why its gates are the strictest: a breaking change here reaches
further than a broken operator.
