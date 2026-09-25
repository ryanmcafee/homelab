# The fork-ability contract

Normative. Decision records: ADR-028, refined by ADR-032, in
[`docs/project_notes/decisions.md`](../project_notes/decisions.md).

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

Fork-ability is checked in four places, in increasing cost:

| # | Check | When | What it catches |
|---|---|---|---|
| 1 | **Render with a synthetic ConfigSet.** Render every chart and manifest against an environment whose values are all synthetic (`DOMAIN: example.invalid`, RFC 5737 addresses), then grep the rendered output for any value from the real environment. Paired with `homelab config guard` over the repository's own source. | Level-0 static verification, every PR | A literal that escaped the ConfigSet |
| 2 | **`homelab.yaml.example` completeness.** Every key the render **or the bootstrap** requires appears in the example file with a `REPLACEME-` or clearly synthetic value. | Level-0, every PR | A new required key that a fork cannot discover |
| 3 | **The fork path itself.** A clean clone, a filled-in ConfigSet, the documented bootstrap, on a machine with none of the maintainer's credentials **and not in this cluster's topology**. | Per release, and for any change to bootstrap, secrets or identity | Documentation drift, undeclared prerequisites, "works because it was already installed", a shape that only this cluster has |
| 4 | **Bootstrap key resolution.** The bootstrap resolves every operator-specific value from the ConfigSet and exits non-zero naming the missing key — every missing key, not the first one. | Runtime, in the Go CLI; exercised by check 3 | A value the bootstrap needs that no render requires, so checks 1–2 never see it |

Checks 1, 2 and 4 are mechanical and fail a pull request rather than being found by a stranger
months later. Check 3 cannot be fully automated because its whole point is the absence of local
state; it is a run, and it produces a written result.

### The scan scope is part of the check (ADR-032)

Check 1's real scope is two lists in `internal/config/guard.go`: `DefaultGuardPathspecs` and
`guardScanExtensions`. The rule above says "no file in this repository"; the scan sees only what
those lists admit. **Any file type or directory outside them is unenforced, whatever this
document says.** Go source was outside both until ADR-032, which is how a defaulted node name in
`cmd/homelab/commands/talos.go` sat in a file the gate could not read.

Two standing conditions follow:

- Adding a language or a top-level directory to the repository means adding it to the scan.
  A new unscanned directory is a silent hole, not a deferred task.
- The synthetic ConfigSet for check 1 must use RFC 5737 values **distinct from** those in
  `configuration/environments/homelab.yaml.example`, which carries plausible RFC 1918 addresses
  (`192.168.1.x`). If the two overlap, the grep cannot tell a leaked real value from a placeholder.

### Values are parameterised; so is shape

Checks 1, 2 and 4 all verify that operator-specific *values* come from the ConfigSet. They do not
verify that the cluster's *shape* does. `homelab.yaml.example` names `CP1_IP`, `CP2_IP`, `CP3_IP`
and states no count, so a fork with one or five control-plane nodes cannot express its topology
even with every value correctly externalised. `CONTROL_PLANE_COUNT` (ADR-031) is the key that
expresses it, and check 3's non-matching topology is what proves it works.

## Who owns the check

| Check | Owner |
|---|---|
| 1 and 2 (static, in level 0), and the scan scope | **SRE & Observability Engineer** — owner of CI quality gates |
| 3 (the fork path run, and the docs it validates) | **DX & Docs Advocate** — owner of fork-path validation and the ambassador funnel |
| 4 (bootstrap key resolution) | **Senior Platform Engineer** — owner of the bootstrap path |
| The rule itself, and adjudicating a claimed exception | **Principal Platform Architect** |

Naming an owner is the point. A rule everybody agrees with and nobody runs is a rule that is
not enforced.

One check, one owner. An issue or acceptance criterion that assigns "the fork-ability gate" to a
single person is malformed — it resolves to either two owners or none. Split it by check against
this table.

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
