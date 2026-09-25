# The fork-ability contract

Normative. Decision records: ADR-029 and ADR-033 (which splits check 3) in
[`docs/project_notes/decisions.md`](../project_notes/decisions.md).

**Read [Current status](#current-status) before citing a check.** Of the four checks below, two
are specified and not implemented, one has never been executed by anyone, and one is automated.
The table states what each check *is*; the status section states what has actually run.

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
resolved at render time. `homelab.yaml.example` is the fork's starting point, and every required
key in it **should** carry a `REPLACEME-` or RFC 5737 value so that forgetting one fails loudly
instead of rendering somebody else's network.

It does not, today. Measured on `main` at `295e0a9`: of 29 top-level keys, 7 carry a `REPLACEME-`
value and 21 lines carry a concrete `192.168.1.x` address — RFC 1918 space, and the most common
home LAN in the world, so a fork on `10.0.0.0/24` fills in the placeholders, gets `[OK]` from
`task config:validate`, and renders a `CP_VIP`, `LB_POOL_*` and `BGP_PEER_IP` pointing into a
subnet it does not have. That is this document's own `DOMAIN` argument turned on itself, and it
is why check 2 cannot pass as written. Tracked in
[homelab#359](https://github.com/ryanmcafee/homelab/issues/359); the sentence above states the
contract, not the current state of the file.

`DOMAIN` is deliberately absent from `defaults.yaml`. That is the pattern to copy: **a default
that silently papers over a missing required value is worse than no default**, because the
fork then comes up wrong instead of failing at render.

## The check

Fork-ability is checked in four places, in increasing cost. A check may be listed here as
specified-and-not-implemented; it may **not** be listed with no status (ADR-033).

| # | Check | When | What it catches | Status |
|---|---|---|---|---|
| 1 | **Render with a synthetic ConfigSet.** Render every chart and manifest against an environment whose values are all synthetic (`DOMAIN: example.invalid`, RFC 5737 addresses), then grep the rendered output for any value from the real environment. | Level-0 static verification, every PR | A literal that escaped the ConfigSet | **Specified, not implemented** |
| 2 | **`homelab.yaml.example` completeness.** Every key the render requires appears in the example file with a `REPLACEME-` or clearly synthetic value. | Level-0, every PR | A new required key that a fork cannot discover | **Specified, not implemented — and fails on `main` today** |
| 3a | **The cold documented Kind path.** A clean clone with no cache and no local state: `task localdev:up` → `localdev:wait` → `localdev:report` → `localdev:down`, each timed, followed by an assertion that the cluster is actually gone. | Weekly cron and on demand | Documentation drift, "works because it was already installed", a teardown that only works after a clean run | **Automated** in [`.github/workflows/fork-path-cold.yml`](../../.github/workflows/fork-path-cold.yml) |
| 3b | **The production bootstrap on foreign hardware.** A filled-in ConfigSet and `task setup -- --environment homelab`, on a machine holding none of the maintainer's credentials. | Before a declared platform milestone | Undeclared physical prerequisites, secret-store and identity assumptions, anything the Kind path cannot reach | **Never executed** |

Checks 1 and 2 are static and belong in the existing level-0 gate, so a violation fails a pull
request rather than being found by a stranger months later. Neither is built yet:
`internal/verify/` has no fork-ability module, and there is no synthetic ConfigSet to render
against — `configuration/environments/` holds only `defaults.yaml`, `homelab.yaml.example` and
`localdev.yaml`. `localdev.yaml` is the nearest thing and is the right starting point for the
synthetic environment, but it uses `homelab.local` and `127.0.0.x` rather than the
`example.invalid` and RFC 5737 values check 1 specifies. Tracked in
[homelab#360](https://github.com/ryanmcafee/homelab/issues/360).

Check 3 was one check until ADR-033. It read "the documented bootstrap", which in this repository
means either `task localdev:up` (Kind, Docker only) or `task setup -- --environment homelab`
(a Proxmox VE host, a 1Password account with a `homelab` vault, a BGP-capable UniFi gateway).
Those two readings differ by a hardware budget, so one check name covering both left neither half
with a determinate pass state. They are now 3a and 3b.

An ephemeral CI runner is an honest proxy for **3a specifically**, because the property 3a tests
is the absence of local state, which is exactly what an ephemeral runner has. It is not a proxy
for 3b, whose prerequisites are physical and cannot be faked in CI.

### Current status

Dated, because a check's status is a claim about the past and decays.

- **3a — automated, first run in flight.** `.github/workflows/fork-path-cold.yml` restores no
  cache and saves none, and fails if a cache directory exists. Added in
  [#352](https://github.com/ryanmcafee/homelab/pull/352); as of 2026-09-25 its first execution is
  still running, so **no cold time to first success has been published yet**. When it lands, that
  is the number to quote for the fork path — not `tilt-ci.yml`'s, which restores a
  `kind-registry-*` pull-through cache and is therefore a lower bound rather than a newcomer's
  experience.
- **3a's change-triggered half is not enforced.** "For any change to bootstrap, secrets or
  identity" is policy in prose. `fork-path-cold.yml`'s `pull_request` filter covers only the
  workflow file itself, deliberately, to keep a cold uncached loop off the pull-request critical
  path. A CODEOWNERS rule cannot carry the obligation either: `.github/CODEOWNERS` assigns
  `* @ryanmcafee`, so every path already has the same single owner and the rule cannot
  discriminate. Closing this needs a `paths:`-triggered check, not a review assignment.
- **3b — never executed, by anyone, as of 2026-09-25.** Not "overdue" and not "pending": it has
  never been run. The nearest measurement is `task validate -- --environment homelab`, which
  reaches 10 of 16 prerequisites with no hardware present and stops at the `proxmox` row. The
  blocker is hardware and secret access, not effort or priority, and it is escalated as a budget
  question in its own right rather than folded into this document.

This section says so plainly because a named check that has never been executed is worse than an
unnamed one: the table's format invites a reader to assume a listed check has passed. Recording
the gap is not contingent on the gap being funded (ADR-033).

Neither 3a nor 3b substitutes for the other. "The fork path is green" is not a statement anyone
may make without naming which half they mean.

## Who owns the check

| Check | Owner |
|---|---|
| 1 and 2 (static, in level 0) | **SRE & Observability Engineer** — owner of CI quality gates |
| 3a (the cold Kind workflow, and the docs it validates) | **DX & Docs Advocate** — owner of fork-path validation and the ambassador funnel |
| 3b (the hardware run, and its written result) | **DX & Docs Advocate** runs it; **Senior Platform Engineer (GitOps & Infrastructure)** supplies the bootstrap path and prerequisites it exercises |
| The rule itself, and adjudicating a claimed exception | **Principal Platform Architect** |

Naming an owner is the point. A rule everybody agrees with and nobody runs is a rule that is
not enforced — and splitting check 3 is what lets 3a's owner be accountable for a check they can
actually run, instead of carrying one they cannot.

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
