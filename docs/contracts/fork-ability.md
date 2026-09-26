# The fork-ability contract

Normative. Decision records: ADR-029, refined by ADR-033 (check 3a/3b and the status
column) and ADR-037 (the scan scope and check 4), in
[`docs/project_notes/decisions.md`](../project_notes/decisions.md).

**Read [Current status](#current-status) before citing a check.** Of the five checks below, three
are specified and not implemented, one has never been executed by anyone, and one is automated and
passing. The table states what each check *is*; the status section states what has actually run,
when, and with what result.

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

**No two example ConfigSets may draw from the same reserved address range.** Check 1 greps a
render for values from the real environment; that grep can only tell a leak from a placeholder if
each `configuration/environments/*.yaml.example` owns its range outright — `homelab.yaml.example`
RFC 1918, a one-node example RFC 5737, a third whatever is left. This is enforced, not
aspirational: `TestExampleConfigSetsAreDisjoint` (over
[`internal/config/exampleranges.go`](../../internal/config/exampleranges.go)) fails the build and
names the shared range and the declaration in each file that claims it. Adding a range to the
template placeholder allowlist in `internal/config/guard.go` does not entitle a second file to
reuse it.

`DOMAIN` is deliberately absent from `defaults.yaml`. That is the pattern to copy: **a default
that silently papers over a missing required value is worse than no default**, because the
fork then comes up wrong instead of failing at render.

## The check

Fork-ability is checked in five places, in increasing cost. A check may be listed here as
specified-and-not-implemented; it may **not** be listed with no status (ADR-033).

| # | Check | When | What it catches | Status |
|---|---|---|---|---|
| 1 | **Render with a synthetic ConfigSet.** Render every chart and manifest against an environment whose values are all synthetic (`DOMAIN: example.invalid`, RFC 5737 addresses), then grep the rendered output for any value from the real environment. Paired with `homelab config guard` over the repository's own source. | Level-0 static verification, every PR | A literal that escaped the ConfigSet | **Specified, not implemented** |
| 2 | **`homelab.yaml.example` completeness.** Every key the render **or the bootstrap** requires appears in the example file with a `REPLACEME-` or clearly synthetic value. | Level-0, every PR | A new required key that a fork cannot discover | **Specified, not implemented — and fails on `main` today** |
| 3a | **The cold documented Kind path.** A clean clone with no cache and no local state: `task localdev:up` → `localdev:wait` → `localdev:report` → `localdev:down`, each timed, followed by an assertion that the cluster is actually gone. | Weekly cron and on demand | Documentation drift, "works because it was already installed", a teardown that only works after a clean run | **Automated and passing** in [`.github/workflows/fork-path-cold.yml`](../../.github/workflows/fork-path-cold.yml) — `18m 55s` cold, 2026-09-25 |
| 3b | **The production bootstrap on foreign hardware.** A filled-in ConfigSet and `task setup -- --environment homelab`, on a machine holding none of the maintainer's credentials **and not in this cluster's topology**. | Before a declared platform milestone | Undeclared physical prerequisites, secret-store and identity assumptions, anything the Kind path cannot reach, a shape that only this cluster has | **Never executed** |
| 4 | **Bootstrap key resolution.** The bootstrap resolves every operator-specific value from the ConfigSet and exits non-zero naming the missing key — every missing key, not the first one. | Runtime, in the Go CLI; exercised by 3b | A value the bootstrap needs that no render requires, so checks 1–2 never see it | **Specified, not implemented** |

Checks 1 and 2 are static and belong in the existing level-0 gate, so a violation fails a pull
request rather than being found by a stranger months later. Neither is built yet:
`internal/verify/` has no fork-ability module, and there is no synthetic ConfigSet to render
against — `configuration/environments/` holds only `defaults.yaml`, `homelab.yaml.example` and
`localdev.yaml`. `localdev.yaml` is the nearest thing and is the right starting point for the
synthetic environment, but it uses `homelab.local` and `127.0.0.x` rather than the
`example.invalid` and RFC 5737 values check 1 specifies. Tracked in
[homelab#360](https://github.com/ryanmcafee/homelab/issues/360).

Check 4 is mechanical too, but it runs inside the Go CLI rather than in level 0, and 3b is what
exercises it. It is not built either: ADR-037 records that the resolver it needs already exists —
`internal/config/eval.go` collects `required key %q is missing or empty` for every missing key —
so what is missing is the wiring from the bootstrap to that resolver, and the exposure of the
bootstrap's required-key set as data so check 2 can consume it rather than fork the list.

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

- **3a — automated, and green on its first run: cold time to first success `18m 55s`, measured
  2026-09-25.** `.github/workflows/fork-path-cold.yml` restores no cache and saves none, and fails
  if a cache directory exists. Added in [#352](https://github.com/ryanmcafee/homelab/pull/352);
  its first execution
  ([run 36099151539](https://github.com/ryanmcafee/homelab/actions/runs/36099151539)) succeeded,
  with `task localdev:up` at `18m 54s`, `task localdev:wait` at `1s`, `task localdev:report` at
  `11s` and `task localdev:down` at `33s`, the cluster confirmed gone afterwards. **`18m 55s`
  (`up` + `wait`) is the number to quote for the fork path** — not `tilt-ci.yml`'s, which restores
  a `kind-registry-*` pull-through cache and is therefore a lower bound rather than a newcomer's
  experience. Re-measure and re-date this line on each weekly run; a cold number more than a few
  weeks old is a claim about a tree that no longer exists.
- **One thing #352 predicted did not reproduce, and one doc defect did.** #352 expected
  `localdev:up` to return well before anything reported Healthy, which is why `localdev:wait` is
  timed separately. On this run `wait` returned in `487ms` with everything already Healthy, so on
  the cold path `localdev:up` alone was sufficient. Keep the two timings separate anyway — one run
  is not a pattern, and the split is what would show the gap reopening. The defect that *is* real:
  `readme.md:31` describes `task localdev:up` as syncing "all 87 Applications", and the run
  reported **60 Applications · 60 Healthy**. Filed as
  [homelab#379](https://github.com/ryanmcafee/homelab/issues/379).
- **3a's pass criterion, so a slow pass is distinguishable from a fail.** 3a fails **only** on a
  non-zero exit from one of the four readme commands, from the warm-cache assertion, or from the
  post-teardown `kind get clusters` assertion. There is no timing threshold, and a slower run is
  **not** a failure — the elapsed time is published as a trend line, not a gate. The reason is that
  a cold run pulls every image from upstream, so its wall clock tracks registry and runner weather
  more than it tracks this repository; a threshold would produce failures that no change here
  caused, and a check that cries wolf gets muted. A regression is therefore read by a human from
  the trend, not enforced by CI. If that stops being good enough, the fix is a threshold on a
  rolling median across runs, not on a single run.
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
- **4 — specified 2026-09-25, not implemented.** Added by ADR-037 on the same day, so it has
  never run and no fork has been caught by it. The resolver it will call already exists and is
  covered; the unwritten part is the bootstrap calling it. Read this row as a commitment, not as
  coverage.

This section says so plainly because a named check that has never been executed is worse than an
unnamed one: the table's format invites a reader to assume a listed check has passed. Recording
the gap is not contingent on the gap being funded (ADR-033).

Neither 3a nor 3b substitutes for the other. "The fork path is green" is not a statement anyone
may make without naming which half they mean.

### The scan scope is part of the check (ADR-037)

Check 1's real scope is two lists in `internal/config/guard.go`: `DefaultGuardPathspecs` and
`guardScanExtensions`. The rule above says "no file in this repository"; the scan sees only what
those lists admit. **Any file type or directory outside them is unenforced, whatever this
document says.** Go source was outside both until ADR-037, which is how a defaulted node name in
`cmd/homelab/commands/talos.go` sat in a file the gate could not read.

Three standing conditions follow:

- Adding a language or a top-level directory to the repository means adding it to the scan.
  A new unscanned directory is a silent hole, not a deferred task.
- **`DefaultGuardPathspecs` and the `config-guard` hook in `.pre-commit-config.yaml` are one
  scope expressed twice and must be changed in the same commit.** `internal/config/guard.go`
  says so in a comment at the list itself, and the hook is the half a contributor meets first:
  its `types_or` admits no `go` and its `files:` pattern names neither `cmd/`, `internal/` nor
  `terragrunt/`. Widening one and not the other produces a gate that passes locally and fails in
  CI — or, worse, the reverse.
- The synthetic ConfigSet for check 1 must use RFC 5737 values **distinct from** those in
  `configuration/environments/homelab.yaml.example`, which carries plausible RFC 1918 addresses
  (`192.168.1.x`). If the two overlap, the grep cannot tell a leaked real value from a placeholder.

### Values are parameterised; so is shape

Checks 1, 2 and 4 all verify that operator-specific *values* come from the ConfigSet. They do not
verify that the cluster's *shape* does. The failure mode this section is really about: a *pattern*
of required keys encodes a shape just as firmly as a literal does, and no value-level check can
see it.

That was the state until MCAA-118. `homelab.yaml.example` named `CP1_IP`, `CP2_IP`, `CP3_IP` and
stated no count, and all three were individually required — so a fork running one or five
control-plane nodes could not express its topology even with every value correctly externalised.
The shape was fixed at three whatever the values were.

ADR-035's rule now holds: the count derives from the `^CP([0-9]+)_IP$` key set, so listing your
control plane *is* the act that states your topology. In the schema that set is a `keyPatterns`
entry carrying `role: control-plane-address`; `CP1_IP` stays required on its own and higher
ordinals are optional. The resolver derives the list once into `ResolvedConfig.ControlPlane`, and
templates range over that field instead of naming ordinals.

Two things keep this from sliding back into a shape nothing can see:

- `configuration/environments/single-node.yaml.example` is a committed one-control-plane ConfigSet,
  rendered through every template by `TestExampleRendersEveryTemplate`. Before it existed every
  environment file in the repository declared three control-plane addresses, so nothing in CI had
  ever rendered a topology that was not this cluster's. It uses RFC 5737 TEST-NET-1
  (`192.0.2.0/24`), distinct from the RFC 1918 range above, per the standing condition stated
  earlier in this document.
- `TestSyntheticTopologiesRenderEveryTemplate` covers the remaining permitted counts (3, 5, 7), so
  the contract's `permittedCounts` ceiling is not a set of topologies nothing has ever rendered.

Check 3b's non-matching topology remains the end-to-end proof; the two above are what make a
regression fail in CI rather than in a stranger's fork.

## Who owns the check

| Check | Owner |
|---|---|
| 1 and 2 (static, in level 0), and the scan scope | **SRE & Observability Engineer** — owner of CI quality gates |
| 3a (the cold Kind workflow, and the docs it validates) | **DX & Docs Advocate** — owner of fork-path validation and the ambassador funnel |
| 3b (the hardware run, and its written result) | **DX & Docs Advocate** runs it; **Senior Platform Engineer (GitOps & Infrastructure)** supplies the bootstrap path and prerequisites it exercises |
| 4 (bootstrap key resolution) | **Senior Platform Engineer** — owner of the bootstrap path |
| The rule itself, and adjudicating a claimed exception | **Principal Platform Architect** |

Naming an owner is the point. A rule everybody agrees with and nobody runs is a rule that is
not enforced — and splitting check 3 is what lets 3a's owner be accountable for a check they can
actually run, instead of carrying one they cannot.

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
