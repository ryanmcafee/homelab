# README redesign, animated header, architecture docs, bootstrap fixes — design

Date: 2026-09-16
Branch: `feat/readme-redesign` (off `origin/main` @ 3b4b4b4)
Status: approved in brainstorming; implementation plan follows this spec.

## Goal

Anyone can fork the repo and get a working homelab with one command, understand what they got
from a single screen, and trust that the numbers on that screen are true. The README shrinks
from 426 lines to ~150 visual-first lines; the header becomes an animated SVG that draws the real
system; the architecture docs are regenerated from the current repo instead of patched; the
`homelab bootstrap`/`validate` commands behind `task setup` stop lying about what they do.

## Non-goals

- Changing any chart, Terragrunt unit, or production behaviour.
- Fixing the `workflows` app's missing e2e/smoke coverage (recorded as a gap, not fixed here).
- Live counters in the header (a CI job regenerating the SVG) — deferred; the drift guard makes
  stale numbers fail CI instead.
- Gateway API: none exists in the repo; nothing to document or draw.

## Decisions taken during brainstorming

| Decision | Choice |
|---|---|
| "Single command" | Tiered: `task localdev:up` (Docker only) leads; `task setup` production path is gated and explicit |
| README length | ~150 lines, visual-first (the personal 50-line rule is waived for this repo) |
| Bootstrap bugs | Fixed in this PR, Go changes with table-driven tests |
| Header | v10 of the companion mock-up: terminal on the left, dependency snake on the right, two traffic lanes, chainsaw counter, finale "homelab is online. systems nominal." |
| Wave numbers | Not in the header; they live in `docs/architecture.md` |
| Internal hosts shown | 10 (traefik-internal dashboard excluded) |

## 1. Header: `.github/homelab.svg`

Static SVG, committed. CSS keyframes + SMIL `animateMotion` (both render inside `<img>` on
GitHub). Canvas 1100×404, 27-second loop:

| Time | What happens |
|---|---|
| 0–1 s | terminal types `$ task setup` |
| 1–11 s | snake builds row by row: ANSIBLE → TERRAGRUNT (proxmox-cluster → zfs-pool/-cp → truenas → talos-cluster → cluster-config → gitops-bootstrap); GITOPS BRIDGE (argocd helm + homelab-cmp sidecar → sops-age-key → bridge metadata → root Application), right-to-left; ARGOCD (gitops → sops→ksops → 1password operator → environment-config → homelab-cmp → addons · 32 → applications · 15); NETWORK · VERIFY (chainsaw e2e, tailscale operator, unifi-gateway unit, port-forward ctl, cilium bgp, unifi gateway hub; BGP handshake AS64512 ⇄ AS64513 turns green; `kube-*` rule packet) |
| 11–12 s | TRAFFIC lanes draw: internet → plex (cloudflare → duckdns → unifi wan :443 → port forward kube-plex → bgp route → traefik-external → service → deployment); tailnet → internal (tailnet user → split dns → unifi → subnet router → bgp route → traefik-internal → service → deployment) |
| 12–24 s | tailnet lane cycles 10 internal hosts, 1.2 s each, packet traverses the full route, FQDN/service/deployment labels swap, verdict badge under the deployment; chainsaw counter ticks 0 → 17/17 in the terminal and under the chainsaw node; chainsaw node pulses per route |
| 24.5 s | `✔ homelab is online. systems nominal.`; chainsaw node outline turns green |
| 26–27 s | fade, restart |

Facts baked into the file and where they come from:

| Fact | Source |
|---|---|
| Terragrunt DAG | `terragrunt/environments/homelab/*/terragrunt.hcl` `dependency` blocks |
| gitops-bootstrap resources | `terragrunt/modules/gitops-bootstrap/main.tf` |
| bootstrap secret chain | `charts/bootstrap/templates/{sops-secrets,1password-operator,homelab-environment-config}.yaml` |
| addons · 32, applications · 15 | template counts in `charts/addons`, `charts/applications` |
| BGP ASNs | `BGP_K8S_ASN`, `BGP_ROUTER_ASN` in `configuration/` |
| internal hosts (10) | `tests/snapshots/homelab/*.yaml`, `ingressClassName: internal` |
| plex external path | `external-dns-cloudflare` annotationFilter + `duckdns` app target |
| chainsaw 17 suites | `tests/e2e/*/chainsaw-test.yaml` |
| per-host verdict | e2e suite exists in `tests/e2e/<host>`; smoke = `smoke-<host>` Job in snapshots. argocd: e2e via `argocd-apps`, no smoke. workflows: neither |

Placeholders only: `<DOMAIN>`, no IPs. `DefaultGuardPathspecs` in `internal/config/guard.go`
does not cover `.github/`, so `.github/**` is added to it (with a guard test) and the SVG is
scanned like any other committed file.

## 2. README (`readme.md`, ~150 lines)

Order and budget:

1. Header image (`<p align="center"><img src=".github/homelab.svg" width="100%">`), title, generated badge row, one-line pitch. ≤ 10 lines.
2. **Try it in 5 minutes** — `task localdev:up`, `task localdev:report`, `task localdev:down`, what the loop contains (73 Applications, fakes for 1Password/TrueNAS/UniFi). ≤ 15 lines.
3. **Run it for real** — `task setup`; three prerequisites (Proxmox host, 1Password vault, UniFi gateway with BGP), one line each; `task validate` names what is missing. ≤ 15 lines.
4. **What you get** — one table, 8 rows (Host, Infra, Bridge, GitOps, Secrets, Config, Network, Verify), columns Layer · Tool · Where in the repo. ≤ 20 lines.
5. **Apps** — two pill rows (Media, Platform), counts, link to `docs/applications.md`. ≤ 10 lines.
6. **How it stays honest** — 6 one-line bullets: level 0 → Kind+ArgoCD+chainsaw on every PR; PR previews on label; Renovate automerge gated on upstream diff; PII guard on commit; weekly restore drill; read-only production for agents; etcd on dedicated NVMe. ≤ 10 lines.
7. **Repository map** — ≤ 12-line tree, entries link to directories.
8. **Docs** — architecture · networking · applications · local development · runbooks · ADRs. ≤ 8 lines.

Removed from the README (moved, not deleted): Highlights, Objectives, Technology Stack, Managed
Dependencies, Tool Management, Secrets Management, Configuration System, Hardware Setup Notes,
Design Patterns, References. Destinations: `docs/architecture.md` (stack, dependencies, config
system, design patterns), `docs/hardware.md` (hardware notes), `docs/secrets.md` (new: the
secrets walkthrough), `docs/tooling.md` (new: mise/tool management). Every removed section is
reachable from the README Docs list.

Generated content: the badge row's versions come from `configuration/versions.yaml`
(`tools.*`, `charts.argocd`, `charts.cilium`). Counts (addons, applications, Applications,
suites, internal hosts) are computed. See §5 for how they are kept true.

## 3. Architecture docs

Rewritten from the current repo, Mermaid diagrams, one diagram per layer, each the zoomed-in
version of a header row so README and docs tell the same story.

**`docs/architecture.md`**
1. Provisioning — Ansible roles (`site.yml` order) → Terragrunt DAG (all 11 units, including the three `talos-image*` variants and the independent `unifi-gateway`) → Talos: 3 control planes on `cp-storage` (NVMe), 3 workers on `vm-storage`, VIP, Intel GPU worker (`gpu_vendor = "intel"`). Why the pools are split (etcd fsync, PR #288) in one paragraph with a link to the runbook.
2. GitOps bridge — resources `gitops-bootstrap` creates; ArgoCD app-of-apps gitops → bootstrap → addons → applications → previews ApplicationSet; sync waves table lives here.
3. Secrets & configuration — SOPS/ksops → 1Password operator → `homelab-environment-config` → CMP render (`homelab config export --stdout | helm template`); localdev equivalent (`values-localdev.yaml`, capability keys; ADR-011/012); child `*-config` charts and `valuesObject` (ADR-010).
4. Storage — democratic-csi NFS + iSCSI (ssd, hdd) → TrueNAS; local-path in Kind; CloudNativePG + barman-cloud; Spegel.
5. Verification — level 0/1/2, chainsaw suites, PostSync smoke Jobs, PR previews (ADR-013), read-only production, restore drill, Renovate gate (ADR-014).

**`docs/networking.md`** — Cilium LB IPAM + BGP (AS64512 ⇄ AS64513; FRR neighbor config written by `unifi-gateway`); two Traefiks; ingress inventory table (3 external, 10 internal; generated); external-dns cloudflare + unifi; port-forwarding controller; Tailscale operator (subnet router `homelab-subnet-router`, API server proxy, split DNS `<DOMAIN>` → gateway); DNS resolution flow for both lanes. MetalLB removed everywhere. Addresses as `<KEY>` placeholders.

**New `docs/applications.md`** — full addon + application table: name, chart, version (from `versions.yaml`), ingress class, e2e suite, smoke Job. `workflows` row shows the coverage gap with a TODO.

**Also updated:** `docs/hardware.md` (3 CPs, cp-storage, Intel GPU, remove NVIDIA as current);
`docs/runbooks/talos-upgrade.md` (stale subnet); `docs/local-development.md` (Tilt wording →
Kind + ArgoCD loop). CLAUDE.md `Project Structure` block (addons "18 templates", applications
"9 templates") corrected. Untouched: ADRs, `docs/project_notes/`, other runbooks.

## 4. Bootstrap fixes (`cmd/homelab`)

Bugs being fixed (`cmd/homelab/commands/bootstrap.go`, `validate.go`):
- `--yes` with no `--environment` selects `homelab` (bootstrap.go:81-83).
- `deployLocaldev` runs kind + tilt, never ArgoCD, and prints stale URLs (bootstrap.go:199-226).
- `deployHomelab` references a non-existent `plan.md` (bootstrap.go:231) and execs
  `ansible-playbook`/`terragrunt` directly, bypassing the Taskfile's 1Password wiring.
- Environment check looks for `.envrc`/`TF_VAR_proxmox_api_url`, which the configuration system
  replaced with `configuration/environments/homelab.yaml`.
- `validate` only checks mise.

**Tier selection** (`homelab bootstrap`, what `task setup` runs)
- One prompt: Kind loop or production. Default **localdev**.
- Auto-detect sets the default only: production is suggested when
  `configuration/environments/homelab.yaml` exists and `PROXMOX_IP:8006` accepts a TCP
  connection (1 s timeout). Detection never selects production on its own.
- `--environment localdev|homelab` (existing flag, kept) makes the tier explicit.
- `--yes` skips confirmations inside the chosen tier only. `--yes` without `--environment` is
  localdev. Production requires `--environment homelab`; there is no path from a bare command to
  `terragrunt apply`.

**localdev path** — shells out to the Taskfile: `task localdev:up`, then `task localdev:wait`;
prints the ArgoCD URL/credentials hint and `task localdev:report` / `task localdev:down`.

**homelab path** — same four phases (Proxmox installed? → Ansible → Terragrunt → GitOps), every
step through the Taskfile (`task ansible:apply`, `task tf:apply ENV=homelab`); each phase names
its doc (`docs/architecture.md#provisioning`, `docs/runbooks/control-plane-storage.md`).
`plan.md` reference removed.

**`homelab validate`** — per-tier table, ✔/✘ per row with a fix hint; `--environment` selects
the tier (default localdev); exit 1 if any required row fails.
- localdev rows: mise, task, bun, docker (daemon reachable), kind, kubectl, helm, argocd,
  chainsaw.
- homelab rows: localdev rows + terragrunt, talosctl, ansible-playbook, `op` (signed in:
  `op whoami`), age key file, `homelab.yaml` present and schema-valid (`task config:validate`
  equivalent in-process), Proxmox reachable.

**Structure** — new `internal/prereq` package: `Check{Name, Tier, Run func(Env) Result, Hint}`,
`Env` interface (`LookPath`, `Dial`, `Stat`, `Run`) so tests inject fakes; `bootstrap.go` and
`validate.go` become thin cobra wrappers. Tier detection is `prereq.DetectTier(env, cfgPath)`.

**Tests** (table-driven, written first):
- `DetectTier`: no config → localdev; config + Proxmox unreachable → localdev; config +
  reachable → homelab suggested.
- Flag semantics: `--yes` alone → localdev; `--yes --environment homelab` → homelab; prompt
  default is the detected tier.
- `validate`: each row's pass/fail through the fake `Env`; exit code 1 on failure; tier
  filtering.
- Existing `cmd/homelab/commands/*_test.go` conventions (plain `testing`, no framework).

## 5. Drift guard: `task docs:check`

A TypeScript script `scripts/docs-check.ts` (tests in `scripts/docs-check_test.ts`) that computes:
- versions from `configuration/versions.yaml` and compares to the README badge row;
- counts: addons templates, applications templates, ArgoCD Applications in the homelab
  snapshots, chainsaw suites in `tests/e2e`, internal ingress hosts in the snapshots;
- compares them to the README, `docs/applications.md`, the ingress table in
  `docs/networking.md`, and the literals in `.github/homelab.svg` (`addons · 32`,
  `applications · 15`, `N/17 suites`, `73 apps synced`, the host list).

`task docs:check` fails with a one-line diff per mismatch; `task docs:check -- --fix` rewrites
the generated regions (marked with `<!-- docs-check:begin <key> -->` / `end` comments in Markdown;
in the SVG, plain string replacement of the known literals). Runs in `verify.yml`'s `policy` job
next to `docs:embedme:verify`. No new workflow.

## 6. Delivery

One PR from `feat/readme-redesign`, commits in this order so each is reviewable alone:
1. `feat(readme): animated header` — `.github/homelab.svg`
2. `feat(cli): tier-aware bootstrap and validate` — `internal/prereq`, cobra wrappers, tests
3. `docs: regenerate architecture and networking from the current repo` — docs files
4. `feat(docs): drift guard` — `scripts/docs-check.ts`, Taskfile, `verify.yml`
5. `docs(readme): 150-line visual-first README` — `readme.md`, CLAUDE.md structure block

PR body carries the `task verify:claim` block per `pr-contract.yml`. Merged with auto-merge once
CI is green (branch protection requires the verification-claim check).

## Open items recorded, not done here

- `workflows` (argo-workflows) has no chainsaw suite and no smoke Job.
- `docs/runbooks/talos-upgrade.md` subnet correction is folded in; the earlier idea of an
  aggregator CI job is still unresolved and out of scope.
