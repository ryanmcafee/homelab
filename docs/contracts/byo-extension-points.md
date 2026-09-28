# BYO-* extension points

Normative. Decision record: ADR-028 in [`docs/project_notes/decisions.md`](../project_notes/decisions.md).

Four things every serious adopter brings with them: their cloud, their encryption key, their
identity centre, and — increasingly — the identities their AI agents act under. Each is
designed as a pluggable seam **now**, before the first customer asks.

**A customer-specific branch is a design defect, not a delivery shortcut.** The failure mode
this document prevents is well known and always looks reasonable at the time: a customer needs
Azure, a branch is cut, and eighteen months later there are five branches and no product.

The same seams serve the homelab surface, which is what keeps them honest. Homelab uses one
provider per seam; enterprise uses another. If a seam only ever has one implementation, nobody
finds out it leaks until it is too expensive to fix.

## The rules that apply to all four

1. **The interface is defined in the SDK, in terms of the platform's own vocabulary** — never
   in terms of one provider's. `getSigningKey()`, not `getKmsKeyArn()`. A provider noun in the
   interface has already leaked the provider into every caller.
2. **Providers are selected by configuration and resolved at startup.** No `if (provider ===
   "aws")` in business logic, anywhere. One switch, in one factory, per seam.
3. **Two implementations exist before the seam is considered designed.** One is enough to
   write an interface that only fits that one. The homelab default and one alternative is the
   minimum.
4. **A conformance test suite is part of the seam, not part of an implementation.** Every
   provider runs the same suite. Adding a provider means passing it, not editing it.
5. **Capability is explicit and degradation is explicit.** A provider declares what it does
   not support; the platform refuses the operation with a clear error rather than silently
   doing something weaker. A seam that silently degrades is worse than one that fails.

## 1. BYO cloud

**Seam:** infrastructure provisioning and the managed services the platform depends on
(object storage, DNS, load balancing, managed Postgres where used).

**Interface:** a provider module exposing declarative resources the `infra-operator` consumes,
plus a Terragrunt/Terraform module set per provider behind one input contract.

**Implementations:** Proxmox + TrueNAS (homelab, the default), and one public cloud. The
homelab path is not a toy version of the cloud path — it is a peer implementation of the same
interface, and it is the one that proves the seam is real.

**Not in the interface:** anything that only one provider can do. If a capability cannot be
expressed for both, it is a provider-specific extension a caller must opt into by name, and it
is documented as non-portable.

**Blast radius:** a provider outage stops provisioning and stops any capability backed by that
provider's managed service; it must not stop reconciliation of already-provisioned resources.

## 2. BYO encryption key

**Seam:** the root of trust for data the platform encrypts — secrets at rest in Git, backup
encryption, and per-tenant envelope keys.

**Interface:** `encrypt(keyRef, plaintext)`, `decrypt(keyRef, ciphertext)`,
`rotate(keyRef)`. **Envelope encryption only — the platform never holds the root key.** It
holds data-encryption keys wrapped by a key the customer controls and can revoke.

**Implementations:** SOPS + Age (homelab, today — ADR-003) and a cloud KMS. The 1Password
Operator and External Secrets sit *above* this seam: they deliver material into the cluster,
they are not the root of trust.

**Non-negotiable:** the customer can revoke the key and the platform loses access. If revoking
the key does not actually lock the platform out, it was never the customer's key. That is the
whole reason BYO-key exists, and it is a conformance test, not a promise.

**Key rotation is a supported operation with a documented window**, not a migration project.

**Blast radius:** the widest of the four. Losing key access makes encrypted data unreadable —
the recovery path is the customer's key custody, not ours. This is stated plainly in the
conformance suite and in the operator documentation.

## 3. BYO identity centre

**Seam:** authentication of human principals and the mapping from external groups to platform
roles.

**Interface:** OIDC. Not "OIDC plus a vendor SDK" — the vendor-agnostic protocol, with
discovery, a configurable claims mapping, and a group-to-role mapping expressed as
configuration.

**Implementations:** any OIDC provider. Homelab uses one (Google, as an Envoy Gateway
`SecurityPolicy` on the HTTPRoute, ADR-040); enterprise customers bring Okta, Entra, Keycloak or their own.
The platform stores a stable subject identifier and never the provider's internal user object.

**Rule:** authorization decisions are made against **platform roles**, never against raw
external group names in application code. The mapping is configuration at the edge; past it,
only platform roles exist. Otherwise every customer's group naming becomes a code change.

**Blast radius:** identity-provider outage blocks new logins. Existing sessions continue to
their expiry, and a documented break-glass path exists that does not depend on the external
provider — because "we cannot log in to fix the thing that stops us logging in" is a real
outage class.

## 4. BYO AI agent identity

**Seam:** the identity an autonomous agent acts under. Distinct from human identity on
purpose: agents are numerous, short-lived, act without a human in the loop, and need
revocation measured in seconds.

**Interface:** `AgentIdentity`, a CRD owned by the `identity-broker`. It declares the agent's
principal, the roles it may assume, a **mandatory** maximum credential lifetime, and an
attestation source.

**Implementations:** Kubernetes ServiceAccount token projection with a bound audience
(homelab and the default), and workload-identity federation to a customer's provider
(enterprise).

**Rules that are not negotiable, because agent identity is the newest trust boundary and the
one with the least industry convention:**

- **Short-lived credentials only.** A static long-lived agent token is not an implementation of
  this seam; it is a bypass of it. The interface has no method that returns one.
- **Every agent action is attributable** to an `AgentIdentity` and carried as the CloudEvents
  `source`, so an audit answers "which agent did this" from `PF_AUDIT` alone.
- **Revocation is immediate and testable**, and immediacy is a conformance test with a stated
  bound, not an aspiration.
- **An agent's roles are a subset of the roles of the principal that created it.** An agent
  cannot be used to escalate past the human who deployed it — this is checked by the broker at
  admission, not by convention.

**Blast radius:** broker outage stops issuing new agent credentials; already-issued
credentials keep working until they expire, which is what bounds the damage and why the
maximum lifetime is mandatory rather than advisory.

## Where two of these seams meet the event bus

There are still four seams. This section names the one place seams 3 and 4 bind to a concrete
mechanism, because that binding is where a customer-specific fork would otherwise appear.
Decision record: ADR-043.

**The seam:** `BusPrincipal -> NATS user`. A platform principal — a human via OIDC, an
`AgentIdentity`, or a platform component — has to become something the NATS server will accept on
a connection, with permissions narrow enough to hold the tenant boundary in
[`event-contract.md`](event-contract.md) §5.

**The interface is a declaration, not a credential format.** Per principal: the subjects it may
publish, the subjects it may subscribe to, and its `$JS.API` allow-list. Nothing in it names a
credential mechanism, an issuer or a provider. That declaration is the artifact both
implementations consume, and it is what makes this one seam rather than two permission models that
drift.

**Implementations:**

- **Static.** The declaration renders into the server's account configuration; the credential is a
  Secret, provisioned the way every other secret here is. Homelab's default, and the bootstrap
  path — a bus that needs a service of ours running before it will accept a connection cannot come
  up from cold.
- **Auth callout.** The declaration renders into a short-lived user JWT, minted by a callout
  service after it authenticates the principal against the BYO identity centre (seam 3) or the
  `AgentIdentity` broker (seam 4). This is the path that satisfies seam 4's short-lived-only rule
  on the bus, because a static NATS credential for an agent is exactly the long-lived token that
  interface refuses to return.

**Rules:**

- **A tenant's permission set is generated from the declaration, never hand-written per customer.**
  A hand-maintained account block is the fork this document exists to prevent, in the one file
  where it would be least visible.
- **No principal is granted a wildcard tenant.** `pf.*.>` and `pf.>` are not available to any
  implementation of this seam, platform components included.
- **The conformance suite belongs to the seam** and asserts the same declaration produces the same
  accepted *and refused* operations under both backends — the refusals being the half a permission
  test usually omits.

**Blast radius:** the callout service being down blocks *new* connections and leaves established
ones running to their credential expiry — the same bound seam 4 puts on the identity broker, and
the reason the static backend remains the bootstrap path rather than a legacy option.

**Deliberately not adopted:** the NATS operator/nsc JWT hierarchy. It is a server-wide mode switch
that forecloses the static backend and makes an operator seed a permanent custody obligation, and
auth callout provides dynamic issuance without it. The declaration above is what keeps nsc a third
backend for a customer who already runs it, rather than a migration.

## What "designed as a seam" means for review

A design that crosses one of these four is reviewed against this list, and the review states
approve / approve-with-conditions / reject with the specific conditions:

- [ ] The interface uses platform vocabulary, with no provider noun in a signature.
- [ ] Provider selection is configuration, resolved once, at one place.
- [ ] Two implementations exist or are specified.
- [ ] The conformance suite covers the seam, and both implementations pass it.
- [ ] Unsupported capabilities are declared and fail loudly rather than degrading silently.
- [ ] Blast radius is named.
