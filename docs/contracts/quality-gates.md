# Quality gates at boundaries

Normative. Decision record: ADR-030 in [`docs/project_notes/decisions.md`](../project_notes/decisions.md).

A boundary is anywhere data crosses between services, between trust domains, or between
versions of the same thing over time. This document says what must be true at each, and by
what mechanism — because "we review carefully" is not a mechanism.

The governing principle is the one that already runs this repository (ADR-009): **the static
gate is the gate.** No skip lists, no "this one is fine", no exceptions that live in
somebody's memory.

## 1. The gate ladder

The existing three-level model is where these gates live; they extend it rather than
introducing a parallel system.

| Level | Cost | Boundary gates it carries |
|---|---|---|
| **0 — static** | seconds, every PR | Event contract check, OpenAPI compatibility diff, CRD round-trip, fork-ability checks 1–2, render + schema validation, ADR-record uniqueness |
| **1 — Kind dry-run** | minutes | Operator idempotency (reconcile twice, assert zero writes), upgrade diff, conversion webhook both directions |
| **2 — Kind live + e2e** | longer | Consumer contract tests against a live JetStream, rollback drill, restore drill |

## 2. Contract tests

**Every boundary has a test that fails when the contract changes, and it lives with the
contract, not with the implementation.** The event gate is the worked example and the pattern
the others follow:

1. A **frozen baseline** in the repository (`contracts/events/registry.v1.baseline.json`).
2. A **diff** against it.
3. A **named rule set** that says which differences are breaking, so the failure message tells
   you what you broke rather than asking a reviewer to spot it.
4. A **test for the checker itself** (`scripts/contract-check_test.ts`), including a test that
   the baseline is in sync with the registry — otherwise an additive change silently leaves a
   stale, permissive baseline and the *next* breaking change passes.

Point 4 is the one that is usually skipped and the one that decides whether the gate is real.
A compatibility checker with no tests is a compatibility checker that quietly stopped working.

The decision record is a boundary too, and it is gated the same way (ADR-039). An ADR number
is cited by files that outlive every branch, so two headings claiming it makes every one of
those citations ambiguous — and because the two headings land at different offsets, git merges
them with no conflict and nothing else in the repository notices. `decisions/adr-numbers` and
`decisions/adr-format` at level 0 are the diff and the rule set; `internal/verify/decisions_test.go`
is point 4, including a test that runs the checker against the committed record. Note what
"gated" means here today: level 0 on the PR **head** is `main`'s required check, and the
merge-result run reports without blocking, so the collision stops the merge at the rebase
rather than at the merge button — and on a draft or a `renovate/*` head, where that required
job is skipped and **a skipped check run satisfies a required context**, it does not stop the
merge at all (ADR-039, `docs/runbooks/verification.md`).

Consumer-side: each consumer of an event type keeps a fixture of the event it expects and
asserts it validates against the published schema. That is what catches "the producer's
additive change was additive for the schema but not for my parser".

## 3. Schema compatibility rules

Uniform across events, HTTP and CRDs, so nobody has to remember three rule sets:

**Additive (allowed within a major):** new optional field, new enum value in a *response*, new
endpoint, new event type, new optional attribute, relaxing a constraint.

**Breaking (requires a new major, published alongside the old):** removing or renaming a
field, making an optional field required, narrowing a type or constraint, removing an enum
value, new enum value in a *request* the server must understand, weakening a delivery or
ordering guarantee, changing the meaning of an existing field without changing its name.

The last one is the dangerous entry: it passes every mechanical check. It is caught only at
review, which is why a design review states what it checked rather than "looks good".

## 4. Upgrade and rollback paths

**Every change that crosses a boundary states its rollback before it merges**, in the pull
request, in one sentence. Not a plan document — a sentence a tired on-call engineer can act on.

- **Additive schema change:** roll back the code; the schema is compatible in both directions,
  so no data migration is needed. This is why additive is the default.
- **New major version:** old and new run side by side. Rollback is routing traffic back. The
  old version cannot be removed until its consumers are known to be gone, and "known" means
  measured — a per-version consumer metric — not assumed.
- **CRD version change:** the conversion webhook works in both directions, and level 1 proves
  it by applying the previous version's fixtures. A one-way conversion is not a rollback path.
- **Database migration:** expand → migrate → contract, with the contract step in a later
  release. A migration that cannot be rolled back is escalated before it is written, not after
  it fails.
- **Operator upgrade:** the new operator reconciles resources created by the old one without
  edits, and the old operator tolerates resources created by the new one for the duration of a
  rollout. Both directions, because a partial rollout is the normal state during an upgrade.

`task verify:upgrade` already renders every chart at a base ref and at the working tree and
diffs the manifests (ADR-014). Contract diffs are the same idea applied to the API surface.

## 5. The boundary review checklist

A design crossing a service or trust boundary is reviewed against this list, and the review
states **approve / approve-with-conditions / reject** with the specific conditions. "Looks
good" is not a review; say what was checked and what tradeoff was accepted.

- [ ] The contract is published and versioned before the implementation.
- [ ] Delivery and ordering guarantees are stated explicitly per path — no path left to the
      reader's assumption.
- [ ] Consumers are idempotent on `(source, id)`; handlers are safe to run twice.
- [ ] Trust boundaries are enumerated, and data crossing one is validated **and** authorized.
- [ ] Blast radius is named: what breaks when this fails, and how far it travels.
- [ ] The failure path exists and has a subscriber — including the max-deliveries advisory.
- [ ] The rollback is stated in one sentence.
- [ ] No BYO-* concern is implemented as a conditional fork.
- [ ] Nothing operator-specific is hard-coded.
- [ ] A compatibility test exists and fails when the contract changes.

The author of a cross-boundary design does not approve it. The Principal Platform Architect's
own cross-boundary designs get a second reviewer.
