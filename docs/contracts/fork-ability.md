# The fork-ability contract

Normative. Decision record: ADR-028 in [`docs/project_notes/decisions.md`](../project_notes/decisions.md).

## The rule

> **No feature ships unless a stranger can fork this repository and run it with their own
> domain, cloud, secrets and identity provider.**

This is a product requirement, not polish. A feature that only works on the maintainer's
cluster is **unfinished**, and it is reviewed as unfinished — not as done-with-a-follow-up.

The reason is commercial, not aesthetic. Homelab is the adoption funnel: technologists run it
at home, and they are the people who bring the platform into their employers. A fork that does
not come up is a lost ambassador, and it is also the early warning that the same hard-coding
has reached the commercial product.

## What it forbids, concretely

No file in this repository may contain, outside an `.example` file or a fixture clearly marked
as one:

- a specific domain name or hostname
- a specific IP address or CIDR belonging to one operator's network
- a cloud account id, project id, subscription id or bucket name
- a cluster name, node name or hardware serial
- an email address
- a personal identity-provider tenant, OIDC client id, or group name
- a secret of any kind, in any encoding

Every one of these arrives from the ConfigSet. The mechanism already exists and predates this
document: `configuration/environments/defaults.yaml` holds non-sensitive shared defaults,
`configuration/environments/<env>.yaml` is **gitignored**, and `<KEY>` placeholders are
resolved at render time. `homelab.yaml.example` is the fork's starting point, and every
required key in it has a `REPLACEME-` value so that forgetting one fails loudly instead of
rendering somebody else's domain.

`DOMAIN` is deliberately absent from `defaults.yaml`. That is the pattern to copy: **a default
that silently papers over a missing required value is worse than no default**, because the
fork then comes up wrong instead of failing at render.

## The check

Fork-ability is checked in three places, in increasing cost:

| # | Check | When | What it catches |
|---|---|---|---|
| 1 | **Render with a synthetic ConfigSet.** Render every chart and manifest against an environment whose values are all synthetic (`DOMAIN: example.invalid`, RFC 5737 addresses), then grep the rendered output for any value from the real environment. | Level-0 static verification, every PR | A literal that escaped the ConfigSet |
| 2 | **`homelab.yaml.example` completeness.** Every key the render requires appears in the example file with a `REPLACEME-` or clearly synthetic value. | Level-0, every PR | A new required key that a fork cannot discover |
| 3 | **The fork path itself.** A clean clone, a filled-in ConfigSet, the documented bootstrap, on a machine with none of the maintainer's credentials. | Per release, and for any change to bootstrap, secrets or identity | Documentation drift, undeclared prerequisites, "works because it was already installed" |

Checks 1 and 2 are static and belong in the existing level-0 gate, so a violation fails a pull
request rather than being found by a stranger months later. Check 3 cannot be fully automated
because its whole point is the absence of local state; it is a run, and it produces a written
result.

## Who owns the check

| Check | Owner |
|---|---|
| 1 and 2 (static, in level 0) | **SRE & Observability Engineer** — owner of CI quality gates |
| 3 (the fork path run, and the docs it validates) | **DX & Docs Advocate** — owner of fork-path validation and the ambassador funnel |
| The rule itself, and adjudicating a claimed exception | **Principal Platform Architect** |

Naming an owner is the point. A rule everybody agrees with and nobody runs is a rule that is
not enforced.

## Review conditions

Any design or pull request that touches hostnames, networking, secrets, identity or bootstrap
is reviewed against:

- [ ] Every operator-specific value comes from the ConfigSet, and the key is in
      `homelab.yaml.example`.
- [ ] A required new key has **no** default in `defaults.yaml` — it fails at render instead.
- [ ] The feature works with a different identity provider, not only the one in use here (see
      [byo-extension-points.md](byo-extension-points.md) §3).
- [ ] The documentation tells a forker what they must supply, before they hit the error.
- [ ] Nothing in the diff is a secret, and nothing is an `.example` file that quietly became
      real.

## A live example

The three open GitHub issues that specify ingress hostnames — #40 (`dashboard.…`), #41
(`status.…`) and #51 (`workflows.…`) — all write a concrete personal domain into the issue
body. Written that way they would each violate this contract. The correct form is
`dashboard.<DOMAIN>`, resolved from the ConfigSet, and that is a merge condition on all three
rather than a follow-up. This is not a criticism of those issues; it is what the contract is
for, caught at the point it is cheap.
