# Homelab Project - Claude AI Instructions

Read `AGENTS.md` and apply the rules to all subagents.
When implementing plans, always analyze the plan first and look for opportunities to use sub agents.
Before implementing a plan, ensure that 'bd' is used for task tracking to support saving progress and context for long running tasks.

## Allowed Tools

Tool routing is mandatory, not advisory. Grep/Glob/Read are fallback tools. Every code-exploration session MUST start with `mcp__serena__list_memories` and `mcp__serena__get_symbols_overview` for the relevant files. Using Grep before `search_for_pattern`, or Read before `get_symbols_overview` on a code file, is a bug. Exceptions: non-code assets (YAML values files, plain Markdown, raw HCL), binary output, and files in languages without LSP support.

### Serena Tool Routing

| Task | Use Serena | Instead of |
|------|-----------|------------|
| Regex search with context | `search_for_pattern` | Grep |
| File discovery (.gitignore aware) | `find_file` / `list_dir` | Glob |
| Navigate Go/TS code | `find_symbol` / `get_symbols_overview` | Grep + Read |
| Trace function usage | `find_referencing_symbols` | Grep |
| Persist agent learnings | `write_memory` | N/A |
| Reasoning checkpoints | `think_about_*` tools | N/A |

### Memory System Coexistence (three tiers)

| Tier | Location | Audience | Write when | Read when |
|------|----------|----------|------------|-----------|
| Auto-memory ("claudemem") | `~/.claude/projects/<dash-encoded-clone-path>/memory/` (Claude Code derives the slug from each user's absolute clone path) | Claude (cross-session) | User states a preference, corrects you, or reveals a fact you'll need next session | SessionStart (automatic from system prompt) |
| Serena memories | `.serena/memories/` | Subagents (in-session + cross-session) | You discover a technical pattern, gotcha, or command sequence during a task | Before any exploration: `list_memories` then `read_memory` |
| Project notes | `docs/project_notes/` | Humans | Bugs with fixes, ADRs, PR/issue work logs, durable config facts | When the user asks "what did we decide about X" |

**Rule of thumb:** A human will read it → `docs/project_notes/`. Only Claude reads it and it's task-scoped → Serena. User preference or cross-session profile fact → auto-memory.

## Subagent Routing

The table below names the specialist roles to delegate to. Their definitions are not committed (`.claude/agents/` is gitignored and holds no project agents); when a named agent is not installed, delegate to a general-purpose subagent with the same brief. **Always delegate specialized work** instead of doing it inline. See `AGENTS.md` for coordination rules.

### When to use which subagent

| Task | Subagent(s) | Notes |
|------|-------------|-------|
| **Kubernetes/ArgoCD** | `kubernetes-specialist` | Cluster design, workloads, sync issues, health checks |
| **Terraform modules** | `terraform-engineer` | Module authoring, state management, plan/apply |
| **Terragrunt orchestration** | `terragrunt-expert` | Multi-env configs, DRY patterns, dependencies |
| **CI/CD & pipelines** | `deployment-engineer` | ArgoCD sync waves, deployment strategies |
| **Helm chart changes** | `kubernetes-specialist` + `deployment-engineer` | Template + deploy concerns |
| **Networking/BGP/Cilium** | `network-engineer` | Cilium config, BGP peering, LB IPAM, DNS |
| **Storage/NFS/CSI** | `kubernetes-specialist` | Democratic-CSI, PVC, TrueNAS integration |
| **PostgreSQL/CloudNativePG** | `postgres-pro` | Operator config, HA, backups, query tuning |
| **Database general** | `database-administrator` | Multi-engine, migrations, replication |
| **Secrets/SOPS/1Password** | `security-engineer` | Key management, vault paths, sync wave ordering |
| **Security audits** | `security-engineer` + `code-reviewer` | DevSecOps, vulnerability scanning |
| **Go code** | `golang-pro` | Concurrency, testing, microservices |
| **TypeScript scripts (Bun)** | `typescript-pro` | Bun runtime, scripting patterns |
| **Code reviews** | `code-reviewer` | Quality, security, project rule enforcement |
| **Architecture decisions** | `architect-reviewer` | Design patterns, scalability, trade-offs |
| **Performance issues** | `performance-engineer` | Profiling, load testing, optimization |
| **Debugging** | `debugger` | Root cause analysis, systematic debugging |
| **Incident response** | `devops-incident-responder` | Triage, emergency procedures, postmortems |
| **Reliability/SLOs** | `sre-engineer` | SLI/SLO, error budgets, toil reduction |
| **Resilience testing** | `chaos-engineer` | Failure injection, game days |
| **DevOps general** | `devops-engineer` | IaC, containers, monitoring, observability |
| **Documentation** | `documentation-engineer` | API docs, doc systems |
| **Git workflow** | `git-workflow-manager` | Branching, hooks, release automation |
| **Refactoring** | `refactoring-specialist` | Code smells, safe restructuring |
| **MCP servers** | `mcp-developer` | MCP protocol, tool/resource development |
| **Build systems** | `build-engineer` | Build optimization, caching, bundling |
| **Dependencies** | `dependency-manager` | Security scanning, version conflicts, licenses |
| **Technical docs** | `technical-writer` | User guides, API references |

### Parallel subagent patterns

For multi-concern tasks, launch multiple subagents simultaneously:

```
Helm chart update:     kubernetes-specialist + deployment-engineer + code-reviewer
Security audit:        security-engineer + code-reviewer + network-engineer
New application:       kubernetes-specialist + deployment-engineer + typescript-pro + documentation-engineer
Infrastructure change: terraform-engineer + terragrunt-expert + kubernetes-specialist + sre-engineer
Bug investigation:     debugger + kubernetes-specialist + sre-engineer
Performance issue:     performance-engineer + postgres-pro + network-engineer
```

## Worktrees and Toolchain Gotchas

Learned while landing #261 Section A (PR #264). Each one cost real time once.

| Gotcha | What to do |
|--------|------------|
| mise refuses a fresh git worktree ("Config files ... are not trusted") | `mise trust && mise install` right after `git worktree add`. Pinned tools (terraform, terragrunt, kind, talosctl) show as "missing" until installed; the pre-commit `terraform_fmt`/`terragrunt_fmt` hooks fail with "command not found" until then. |
| Serena is rooted at the directory Claude Code was launched from (`--project-from-cwd`) | Launch Claude Code from the worktree you edit. `.mcp.json` (committed) and `.serena/project.yml` (committed) make Serena available in every checkout; Serena's edit tools refuse paths outside its root, so use Bash/Edit for files in another worktree. |
| Non-interactive shells miss the mise shims | Prepend `$HOME/.local/share/mise/shims` to `PATH` (`go`, `helm`, `bun`, `task` are all mise-managed; `mise.toml` pins `go = "1.25"` and `helm = "4.3.0"`). |
| helm version changes rendered bytes | Golden snapshots are byte-exact against `configuration/versions.yaml` `tools.helm`; keep `mise.toml`, `verify.yml` and `versions.yaml` on the same helm. |
| `go run ./cmd/homelab` collapses child exit codes to 1 | Check exit codes with the built binary (`go build -o bin/homelab ./cmd/homelab`). |
| Terraform warns about the plugin cache dir | `task install-tools` creates `~/.terraform.d/plugin-cache`: the Taskfile `env:` and `.envrc` set `TF_PLUGIN_CACHE_DIR` to that path and, because `mise.toml` loads `.envrc` after its own `[env]`, it overrides the repo-local path `mise.toml` names. |
| Docker Desktop is slow to start; CMP image tags before PR #264 are linux/amd64 only | `open -a Docker` and wait; on Apple Silicon run `task test:cmp-parity -- --platform linux/amd64` for old tags. |
| `git push` over HTTPS occasionally fails ("remote end hung up", transient DNS) | Retry with `git -c http.version=HTTP/1.1 push`. |
| `tests/snapshots/` must stay byte-exact | yamllint and the whitespace pre-commit fixers exclude it; regenerate with `task test:snapshot -- --update`, never hand-edit. |
| `eza`, `fd`, `bat` are not installed | Use `rg` (`rg --files` for listing). |
| `.claude/settings.json` (committed) runs `scripts/claude-verify-hook.ts` after every Edit/Write under `charts/` or `configuration/` of `$CLAUDE_PROJECT_DIR` | Silent on pass; level-0 failures come back as hook feedback. A fresh worktree needs `mise trust && mise install` first or the hook reports mise's not-trusted error. `HOMELAB_VERIFY_HOOK=off` disables it for a long mechanical edit series (then run `task verify:text`). |

## Local Configuration

For environment-specific settings (IP addresses, hostnames, credentials), see `CLAUDE.local.md`.
Copy from `CLAUDE.local.md.example` and customize for your environment.

## Configuration System

All environment-specific values (IPs, domains, hostnames, usernames) are centralized in `configuration/`.

| Command | Description |
|---------|-------------|
| `task config:validate` | Validate schemas + environment values |
| `task config:eval` | Print resolved config as JSON |
| `task config:export` | Export all consumer formats |
| `task config:guard` | Scan every tracked file in the guard scope for PII (the pre-commit hook scans the staged ones) |

### Key Files
- `configuration/schema/*.schema.yaml` — key declarations (committed)
- `configuration/environments/defaults.yaml` — shared defaults (committed)
- `configuration/environments/homelab.yaml` — production PII (GITIGNORED)
- `configuration/environments/homelab.yaml.example` — template (committed)
- `configuration/versions.yaml` — all chart/tool versions (committed)
- `configuration/templates/*.tmpl` — export format templates (committed)

## Project Overview

GitOps-driven homelab infrastructure with:
- ArgoCD App-of-Apps pattern (gitops -> addons -> applications)
- Talos Linux Kubernetes cluster on Proxmox VE
- Multi-environment: localdev (Kind + Tilt) and homelab (production)
- TypeScript scripting only (Bun runtime, no Bash/Python)
- 1Password + SOPS for secrets management

## Helm Chart Version Sources

When updating helm chart versions, check these repositories:

| Chart Category | Source |
|----------------|--------|
| ArgoCD | https://github.com/argoproj/argo-helm/blob/main/charts/argo-cd/Chart.yaml |
| Cilium | https://github.com/cilium/cilium/blob/main/install/kubernetes/cilium/Chart.yaml |
| cert-manager | https://github.com/cert-manager/cert-manager/blob/master/deploy/charts/cert-manager/Chart.yaml |
| external-dns | https://github.com/kubernetes-sigs/external-dns/blob/master/charts/external-dns/Chart.yaml |
| traefik | https://github.com/traefik/traefik-helm-chart/blob/master/traefik/Chart.yaml |
| kube-prometheus-stack | https://github.com/prometheus-community/helm-charts/blob/main/charts/kube-prometheus-stack/Chart.yaml |
| democratic-csi | https://github.com/democratic-csi/charts/blob/master/stable/democratic-csi/Chart.yaml |
| 1password-connect | https://github.com/1Password/connect-helm-charts/blob/main/charts/connect/Chart.yaml |
| cloudnative-pg | https://github.com/cloudnative-pg/charts/blob/main/charts/cloudnative-pg/Chart.yaml |
| paperclip-operator | https://github.com/paperclipinc/paperclip-operator/blob/main/charts/paperclip-operator/Chart.yaml |
| kubelet-csr-approver | https://github.com/postfinance/kubelet-csr-approver/blob/main/charts/kubelet-csr-approver/Chart.yaml |
| metrics-server | https://github.com/kubernetes-sigs/metrics-server/blob/master/charts/metrics-server/Chart.yaml |
| oauth2-proxy | https://github.com/oauth2-proxy/manifests/blob/main/helm/oauth2-proxy/Chart.yaml |
| nvidia-gpu-operator | https://github.com/NVIDIA/gpu-operator/blob/main/deployments/gpu-operator/Chart.yaml |
| Plex | https://github.com/plexinc/pms-docker/blob/master/charts/plex-media-server/Chart.yaml |
| TrueCharts | https://github.com/trueforge-org/truecharts/tree/master/charts/stable/{chart-name}/Chart.yaml |

### Current Versions (Auto-embedded from configuration/versions.yaml)

`configuration/versions.yaml` is the single source of truth for every chart, image and tool
version and the only file Renovate bumps. The homelab environment receives these versions at
render time through the CMP (`homelab config export`) and localdev through the committed, generated
`charts/*/values-localdev.yaml` (`task config:export:localdev`), so the `chart.version` values in
`charts/*/values.yaml` are placeholders that both environments override.

<!-- embedme configuration/versions.yaml -->
```yaml
# Centralized version registry — single source of truth for all chart and tool versions.
# Update this file instead of editing individual values.yaml files.
# Renovate/Dependabot PRs target this file only.

charts:
  # renovate: datasource=helm depName=argo-cd registryUrl=https://argoproj.github.io/argo-helm
  argocd: "9.7.1"
  # renovate: datasource=helm depName=cilium registryUrl=https://helm.cilium.io/
  cilium: "1.19.5"
  # renovate: datasource=helm depName=cert-manager registryUrl=https://charts.jetstack.io
  cert-manager: "v1.20.3"
  # renovate: datasource=helm depName=external-dns registryUrl=https://kubernetes-sigs.github.io/external-dns/
  external-dns: "1.21.1"
  # renovate: datasource=helm depName=kube-prometheus-stack registryUrl=https://prometheus-community.github.io/helm-charts
  kube-prometheus-stack: "87.1.0"
  # CRD-only companion chart installed by the bootstrap chart (wave -1) so ServiceMonitors can
  # render before kube-prometheus-stack (addons wave 9). Its appVersion must be the
  # prometheus-operator version kube-prometheus-stack bundles (87.1.0 -> v0.92.0 -> 30.0.0);
  # Renovate bumps the two in one "Monitoring stack" PR (.github/renovate.json5); never
  # move the CRDs behind the operator by hand.
  # renovate: datasource=helm depName=prometheus-operator-crds registryUrl=https://prometheus-community.github.io/helm-charts
  prometheus-operator-crds: "30.0.0"
  # renovate: datasource=helm depName=traefik registryUrl=https://traefik.github.io/charts
  traefik: "39.0.9"
  # renovate: datasource=helm depName=democratic-csi registryUrl=https://democratic-csi.github.io/charts/
  democratic-csi: "0.15.1"
  # renovate: datasource=helm depName=tailscale-operator registryUrl=https://pkgs.tailscale.com/helmcharts
  tailscale-operator: "1.98.4"
  # renovate: datasource=helm depName=kubelet-csr-approver registryUrl=https://postfinance.github.io/kubelet-csr-approver
  kubelet-csr-approver: "1.2.14"
  # renovate: datasource=helm depName=metrics-server registryUrl=https://kubernetes-sigs.github.io/metrics-server/
  metrics-server: "3.14.0"
  # renovate: datasource=helm depName=connect registryUrl=https://1password.github.io/connect-helm-charts
  onepassword-connect: "2.4.1"
  # renovate: datasource=docker depName=ghcr.io/spegel-org/helm-charts/spegel
  spegel: "0.6.0"
  # renovate: datasource=helm depName=local-path-provisioner registryUrl=https://charts.containeroo.ch
  local-path-provisioner: "0.0.37"
  # renovate: datasource=helm depName=cloudnative-pg registryUrl=https://cloudnative-pg.github.io/charts
  cloudnative-pg: "0.28.3"
  # renovate: datasource=helm depName=plugin-barman-cloud registryUrl=https://cloudnative-pg.github.io/charts
  plugin-barman-cloud: "0.8.0"
  # renovate: datasource=helm depName=argo-workflows registryUrl=https://argoproj.github.io/argo-helm
  argo-workflows: "1.0.18"
  # renovate: datasource=helm depName=plex-media-server registryUrl=https://raw.githubusercontent.com/plexinc/pms-docker/gh-pages
  plex-media-server: "1.6.0"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/sonarr
  sonarr: "25.6.3"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/radarr
  radarr: "26.7.2"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/prowlarr
  prowlarr: "21.7.3"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/nzbget
  nzbget: "29.4.2"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/tautulli
  tautulli: "21.18.2"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/lazylibrarian
  lazylibrarian: "21.18.2"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/home-assistant
  home-assistant: "29.6.2"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/mosquitto
  mosquitto: "17.17.2"
  # renovate: datasource=docker depName=oci.trueforge.org/truecharts/flaresolverr
  flaresolverr: "16.18.2"
  # renovate: datasource=docker depName=ghcr.io/renovatebot/charts/renovate
  renovate: "46.106.12"
  # renovate: datasource=helm depName=gpu-operator registryUrl=https://helm.ngc.nvidia.com/nvidia
  nvidia-gpu-operator: "v26.3.3"
  # renovate: datasource=helm depName=intel-device-plugins-gpu registryUrl=https://intel.github.io/helm-charts
  intel-device-plugins-gpu: "0.36.0"
  # renovate: datasource=helm depName=intel-device-plugins-operator registryUrl=https://intel.github.io/helm-charts
  intel-device-plugins-operator: "0.36.0"
  # renovate: datasource=helm depName=node-feature-discovery registryUrl=https://kubernetes-sigs.github.io/node-feature-discovery/charts
  node-feature-discovery: "0.18.3"
  # renovate: datasource=helm depName=oauth2-proxy registryUrl=https://oauth2-proxy.github.io/manifests
  oauth2-proxy: "10.7.0"
  # renovate: datasource=docker depName=ghcr.io/kashalls/external-dns-unifi-webhook
  external-dns-webhook-unifi: "v0.8.2"
  # renovate: datasource=github-releases depName=lukaszraczylo/traefikoidc
  traefik-oidc: "v1.0.32"
  # renovate: datasource=helm depName=port-forwarding registryUrl=https://ryanmcafee.github.io/port-forwarding-controller
  unifi-port-forward: "1.1.1"
  # renovate: datasource=docker depName=ghcr.io/paperclipinc/charts/paperclip-operator
  paperclip-operator: "0.19.1"
  # One key for base, istiod, cni and ztunnel: the four Istio charts must run the same release.
  # renovate: datasource=helm depName=istiod registryUrl=https://istio-release.storage.googleapis.com/charts
  istio: "1.30.5"
  # renovate: datasource=helm depName=kiali-server registryUrl=https://kiali.org/helm-charts
  kiali-server: "2.32.0"
  # renovate: datasource=helm depName=opentelemetry-collector registryUrl=https://open-telemetry.github.io/opentelemetry-helm-charts
  opentelemetry-collector: "0.173.1"
  # renovate: datasource=helm depName=altinity-clickhouse-operator registryUrl=https://helm.altinity.com
  altinity-clickhouse-operator: "0.27.3"
images:
  homelab-cmp: "0.1.48"
  # renovate: datasource=docker depName=curlimages/curl
  curl: "8.22.0"
  # renovate: datasource=docker depName=kindest/node
  kind-node: "v1.36.1"
  # renovate: datasource=docker depName=versity/versitygw
  versitygw: "v1.8.0"
  # renovate: datasource=docker depName=ghcr.io/paperclipai/paperclip
  paperclip: "2026.916.1"
  # renovate: datasource=docker depName=ghcr.io/cloudnative-pg/postgresql
  cloudnative-pg-postgresql: "17.11"
  # renovate: datasource=docker depName=clickhouse/clickhouse-server
  clickhouse-server: "26.8.10.6"
  # Grafana plugin, installed by the kube-prometheus-stack Grafana at startup.
  # renovate: datasource=github-releases depName=grafana/clickhouse-datasource
  grafana-clickhouse-datasource: "v4.21.3"
tools:
  # talos and kubernetes are the TARGET (Renovate bumps them). What the cluster runs is
  # terragrunt/environments/homelab/env.hcl; while it lags, the lag is registered with a
  # reason in tests/gitops/version-drift.yaml `pins:` or level 0 `versions/pins` fails
  # (docs/runbooks/talos-upgrade.md, docs/plans/2026-09-17-talos-kubernetes-upgrade.md).
  # renovate: datasource=github-releases depName=siderolabs/talos
  talos: "v1.14.0"
  # renovate: datasource=github-releases depName=kubernetes/kubernetes
  kubernetes: "v1.37.0"
  # renovate: datasource=github-releases depName=hashicorp/terraform
  terraform: "1.16.2"
  # renovate: datasource=github-releases depName=helm/helm
  helm: "4.3.0"
  # renovate: datasource=github-releases depName=kubernetes-sigs/kind
  kind: "v0.33.0"
  # renovate: datasource=github-releases depName=kyverno/chainsaw
  chainsaw: "v0.2.15"
  # renovate: datasource=github-releases depName=argoproj/argo-cd
  argocd: "v3.5.3"

```

### Version Update Files
To update a chart, image or tool version:
1. Edit `configuration/versions.yaml` (or let Renovate do it).
2. If the chart ships CRDs, run `task schemas:vendor` and commit `tests/schemas/`.
3. Run `task config:export:localdev` (the committed localdev values embed chart versions), `task verify:text`, then `task test:snapshot -- --update` and commit the snapshots.
4. `task verify:upgrade -- --base origin/main` shows what the upstream chart renders differently. On a PR, `upgrade.yml` posts the same diff, revalidates every custom resource against re-extracted CRD schemas and, on `renovate/*` branches, sets the `upgrade/automerge-gate` status: Renovate automerges non-major bumps only when every check and the gate are green (ADR-014).

Do not edit `chart.version` in `charts/*/values.yaml`; those values are overridden by the CMP in homelab. The exception is `charts/bootstrap` (plain Helm from the Terraform root Application, never the CMP): its pins are the versions production runs. Level 0's `versions/<env>` check fails when any rendered chart version is missing from `versions.yaml`, unless the drift is registered with a reason in `tests/gitops/version-drift.yaml`.

## Project Structure

```
homelab/
├── ansible/              # Proxmox post-install roles + playbooks (site.yml), TrueNAS setup
├── charts/
│   ├── gitops/           # App-of-Apps root: bootstrap, addons, applications, previews
│   ├── bootstrap/        # SOPS secrets, 1Password operator, environment config, ArgoCD self-manage
│   ├── addons/           # Infrastructure Applications (30 templates)
│   ├── applications/     # User workloads (15 templates)
│   ├── secrets/          # SOPS-encrypted secrets (ksops)
│   └── *-config/, *-dependencies/, paperclip*/, duckdns*/  # child charts (ADR-010)
├── cmd/homelab/          # Go CLI: config, verify, bootstrap, validate, scaffold
├── internal/             # Go packages behind the CLI (config, verify, prereq, scaffold)
├── cmp/                  # ArgoCD Config Management Plugin definition (Dockerfile.cmp)
├── configuration/        # Schema, environments, templates, versions.yaml
├── scripts/              # TypeScript automation (Bun)
├── terragrunt/
│   ├── modules/          # Reusable Terraform modules
│   └── environments/     # homelab (11 units) + localdev
├── talos/                # Machine-config templates, patches, image schematics
├── localdev/             # Kind config, fakes, ArgoCD values (Tiltfile is legacy)
├── tests/                # e2e (chainsaw), drills, health, policy, schemas, snapshots
└── docs/                 # Architecture, networking, applications, runbooks, project notes
```

## Taskfile Quick Reference

Run `task --list` for full list. Most commonly used:

| Command | Description |
|---------|-------------|
| `task localdev:up` | Kind (Cilium, registry caches, fakes) + ArgoCD + every Application synced from the working tree |
| `task localdev:warm` | Same with only bootstrap + addons synced; `task localdev:sync` later for applications |
| `task localdev:sync` | Re-sync the working tree into Kind (`-- --only a,b`, `-- --warm`, `-- --dry-run`) |
| `task localdev:wait` / `task localdev:diagnose` | Wait for every Application to be Healthy / dump conditions, events and pod logs |
| `task localdev:ci` | Non-interactive loop CI runs: kind, argocd, sync, wait, e2e |
| `task localdev:down` | Delete the Kind cluster (`-- --purge-cache` also removes the registry caches) |
| `task localdev:report` | Markdown report of the Kind loop: Application table, level-2 verdict, `argocd app diff --revision <base>` vs the base branch (`-- --base main`; the `kind-preview` PR comment) |
| `task verify` | Level-0 static verification: render, kubeconform, gitops graph, snapshots, policy (JSON, < 5 s); the committed PostToolUse hook runs it after every agent edit under `charts/` or `configuration/` |
| `task verify:text` | Level-0 verification, human-readable |
| `task verify LEVEL=1` / `LEVEL=2` | + server-side dry run on Kind (`dryrun/localdev/<chart>`) / + Application health and chainsaw e2e (`argocd/<app>`, `e2e/<test>`) |
| `task verify:claim` | Level-0 claim block for the PR body; `pr-contract.yml` re-runs level 0 on the head and fails on a mismatch |
| `task verify:upgrade -- --base origin/main` | Upstream chart manifests at the base ref vs the working tree (what a version bump really changes) |
| `task verify:prod` / `task prod:status` / `task prod:diff -- <app>` | Read-only production: Application health, table, `argocd app diff` (context `homelab-readonly`, `task prod:kubeconfig` once; `docs/runbooks/readonly-access.md`) |
| `task apiserver:probe` / `task apiserver:stress` | Read-only Kubernetes API probe and GET load ramp; probes the VIP and each control plane side by side, so a VIP failover is distinguishable from an API outage (`docs/runbooks/control-plane-storage.md`) |
| `task drill:restore` | CloudNativePG backup/restore drill in Kind (`tests/drills/`; weekly in `restore-drill.yml`) |
| `task scaffold -- app <name> --pattern operator\|helm\|deps-main-config` | Scaffold a new app (templates, values, schema keys, versions, child charts, e2e, health); `--dry-run` shows the diff; `task test:scaffold` proves every pattern passes level 0 |
| `task test:e2e` | chainsaw suite in `tests/e2e/` against the running Kind loop (`-- --test-dir tests/e2e/<name>`) |
| `task test:health` | ArgoCD health Lua fixtures in `tests/health/` (no cluster) |
| `task test:snapshot -- --update` | Regenerate golden snapshots in `tests/snapshots/` |
| `task test:policy` | conftest policy unit tests + negative fixtures |
| `task schemas:vendor` | Re-vendor CRD JSON schemas from `versions.yaml` pins |
| `task config:export:localdev` | Regenerate the committed localdev parent values from `configuration/` |
| `task chart:lint` | Lint all Helm charts |
| `task chart:template:addons` | Debug addons rendering |
| `task tf:apply:component COMPONENT=X` | Apply single Terraform component |
| `task talos:recreate:node NODE=X` | Recreate Talos node |
| `task gpu:verify` | Verify GPU support |
| `task sops:setup` | Full SOPS setup |
| `task render` | Render inline manifests (Cilium, CSR approver, Spegel) |
| `task render:push` | Upload rendered files to 1Password |
| `task render:pull` | Download rendered files from 1Password |
| `task render:status` | Check status of rendered files (local vs 1Password) |
| `task render:sync` | Sync files between local and 1Password |
| `task docs:embedme` | Update embedded code snippets |

### Rendered Manifest Workflow

Rendered YAML files (Cilium, kubelet-csr-approver, Spegel) are stored in 1Password Documents for cross-machine consistency. This prevents config drift from Helm re-rendering (e.g., Cilium generates new TLS certs on each render).

**Initial Setup (first time):**
```bash
task render           # Generate files locally
task render:push      # Upload to 1Password
```

**New Machine Setup:**
```bash
task render:pull      # Download from 1Password
# OR
task tf:plan          # Auto-syncs before planning
```

**Intentional Cluster Update:**
```bash
task render           # Re-render with new config
task render:push      # Push new versions to 1Password
task tf:plan          # Preview changes
task tf:apply         # Apply changes
```

## ArgoCD Troubleshooting

### Sync Wave Order
- Wave 0: Bootstrap (inside it: namespace/RBAC -3, `sops-secrets` -2, `1password-operator` and `prometheus-operator-crds` -1, `homelab-environment-config` 0, ArgoCD self-manage 1)
- Addons (core infrastructure — via CMP plugin in homelab): wave 1 in homelab (`charts/gitops/values-homelab.yaml`), chart default 2
- Applications (user workloads — via CMP plugin in homelab): wave 10 in homelab, chart default 3
- Full table: `docs/architecture.md` § GitOps bridge

### CMP Architecture
The homelab environment uses an ArgoCD Config Management Plugin (CMP) sidecar to generate environment-specific Helm values at runtime, eliminating PII from committed files.

- **Bootstrap chart** deploys: SOPS secrets, 1Password operator, homelab-environment-config secret
- **CMP sidecar** runs `homelab config export --stdout` piped into `helm template`
- **Localdev** uses native Helm with `values-localdev.yaml`, which is generated from the same templates (`homelab config export --set localdev`, `task config:export:localdev`) and committed; level 0 fails when it is stale (no CMP). Kind differences are capability keys in `platform.schema.yaml` (`ARGOCD_AUTOMATED_SYNC=false`, `MEDIA_PROVIDER=ephemeral`, `CERT_ISSUER=selfsigned`, `STORAGE_PROVIDER=local-path`, `SECRETS_PROVIDER=none`, `KUBELET_SERVING_CERT=self-signed`), never environment-name branches (ADR-011, ADR-012)
- **Child `*-config`/`*-dependencies` charts** stay on plain `helm.valueFiles`; anything derived from `configuration/` (domain, hostnames, IPs, iSCSI portal, e-mail) reaches them via the parent Application's `helm.valuesObject`, so their committed `values-homelab.yaml` carries no PII. Level 0 mirrors this by feeding each child the `valuesObject` extracted from the rendered parent (ADR-010)
- Decisions: `docs/project_notes/decisions.md` (entry "2026-02-11: ArgoCD CMP for PII removal" and ADR-010; the original design doc was removed in c4daa10 once implemented)

### Kind + ArgoCD loop (localdev)
`task localdev:up` creates Kind (`homelab-localdev`, context `kind-homelab-localdev`, Cilium CNI, registry pull-through caches, fakes from `localdev/fakes/`), installs the Prometheus operator CRDs (bootstrap wave -1 in homelab, which Kind never syncs) and then ArgoCD from `versions.yaml` with the health Lua in `charts/bootstrap/files/health/`, applies the root `gitops` Application at the PR head (`-- --revision <ref>` / `LOCALDEV_REVISION`; default the upstream branch of HEAD, `main` with a warning when the branch is not pushed; the `gitops` chart hands the revision to `addons`/`applications` via `helm.valuesObject.global.targetRevision`) and syncs **every Application from the working tree** with `argocd app sync --local`, tier by tier. That requires automated sync off in localdev (`ARGOCD_AUTOMATED_SYNC=false`). After a local sync `Synced` means the tree equals the pushed head and `OutOfSync` means unpushed local changes; `task localdev:wait`, `task verify LEVEL=2` and the e2e tests judge `Healthy` + `operationState.phase == Succeeded`, never sync status. PostSync smoke Jobs (`smoke-<app>`, `<app>.smoke {enabled,url,expect}`) make an operation succeed only when the endpoint answers. `task localdev:diagnose` prints conditions, events and failing pod logs; `task localdev:sync -- --only <app>` re-syncs one app; `task localdev:report -- --base main` prints the Application table and `argocd app diff --revision main` per git-path app. CI runs the same loop in `.github/workflows/tilt-ci.yml` (`kind-argocd`, required; it checks out the PR head SHA and sets `LOCALDEV_REVISION` to it) and posts that report as the sticky PR comment `kind-preview`. Every script pins the Kind context (ADR-009); details in `docs/local-development.md` and ADR-012.

### Previews and read-only production (ADR-013)
- **Previews:** a maintainer labels a PR `preview` (+ `preview:<app>` per app); the `previews` ApplicationSet renders `charts/applications` at the PR head through the CMP in preview mode (`global.preview.*`): Applications `<app>-pr<N>` in namespace `preview-<N>`, AppProject `previews`, hosts `<app>-pr<N>.<domain>`, ephemeral (`emptyDir`) storage; closing or unlabelling deletes it. Level 0 renders it as env `homelab-preview`. `docs/runbooks/previews.md`
- **Read-only production:** agents never mutate homelab. The `agent-readonly` account may also `exec` and port-forward, for diagnosis only (`amtool alert`, the Prometheus API); it still cannot change API objects or read Secrets through the API. `task prod:kubeconfig` (once), then `task verify:prod`, `task prod:status`, `task prod:diff -- <app>` through the `homelab-readonly` context (ServiceAccount `agent-readonly`, Tailscale API server proxy) and the read-only ArgoCD `agent` account. `docs/runbooks/readonly-access.md`

### Common Errors & Solutions
| Error | Cause | Solution |
|-------|-------|----------|
| "OnePasswordItem not found" | 1Password Operator not ready | Check sync wave ordering |
| "Unable to find valid certification path" | TrueNAS TLS not trusted | Democratic-CSI uses allowInsecure |
| "dry run failed" | Server-side apply conflicts | Add ServerSideApply=true to syncOptions |
| Ingress "Progressing" forever | No LoadBalancer IP | Custom health check marks Ingress Healthy |
| API unreachable for seconds, healthy afterwards | etcd fsync stalled by disk contention, leases expire, the Talos VIP moves | `talosctl -n <cp> logs etcd \| rg "slow fdatasync"`; `task apiserver:probe`; `docs/runbooks/control-plane-storage.md` |

### Debug Commands
```bash
kubectl -n argocd get applications -o wide
argocd app get <app-name> --refresh
argocd app sync <app-name> --force
kubectl -n argocd logs -l app.kubernetes.io/name=argocd-application-controller
```

## Environment Configuration

| Feature | localdev | homelab |
|---------|----------|---------|
| Kubernetes | Kind | Talos Linux |
| Storage | local-path-provisioner | Democratic-CSI NFS |
| Load Balancer | disabled/NodePort | Cilium LB IPAM + BGP |
| Secrets | Fake/disabled | 1Password + SOPS |
| GPU | None | NVIDIA GPU (see CLAUDE.local.md for model) |

## TypeScript Scripting Patterns

All scripts run on Bun (`mise.toml` pins it; dependencies are in `package.json` and `bun.lock`):
```typescript
#!/usr/bin/env bun
```

Conventions:
- Run scripts through their `task` entry; `task test:scripts` runs the unit tests (`scripts/<name>_test.ts`, `bun test`), `task scripts:lint` checks format, lint (Biome) and types (tsc), `task scripts:fmt` formats
- Always include `--help` flag
- Use `--dry-run` for non-destructive preview
- Log with colors: cyan=INFO, green=OK, red=ERROR
- Exit 0 on success, 1 on failure

## Project Memory System

This project maintains institutional knowledge in `docs/project_notes/` for consistency across sessions.

### Memory Files

- **bugs.md** - Bug log with dates, solutions, and prevention notes
- **decisions.md** - Architectural Decision Records (ADRs) with context and trade-offs
- **key_facts.md** - Project configuration, ports, important URLs (no secrets)
- **issues.md** - Work log with PR/issue IDs, descriptions, and URLs

### Memory-Aware Protocols

**Before proposing architectural changes:**
- Check `docs/project_notes/decisions.md` for existing decisions
- Verify the proposed approach doesn't conflict with past choices
- If it does conflict, acknowledge the existing decision and explain why a change is warranted

**When encountering errors or bugs:**
- Search `docs/project_notes/bugs.md` for similar issues
- Apply known solutions if found
- Document new bugs and solutions when resolved

**When looking up project configuration:**
- Check `docs/project_notes/key_facts.md` for configuration, ports, URLs
- Reference `CLAUDE.local.md` for environment-specific values (IPs, hostnames)
- Prefer documented facts over assumptions

**When completing work on tickets/PRs:**
- Log completed work in `docs/project_notes/issues.md`
- Include PR/issue ID, date, brief description, and URL

**When user requests memory updates:**
- Update the appropriate memory file (bugs, decisions, key_facts, or issues)
- Follow the established format and style (bullet lists, dates, concise entries)

## IMPORTANT

ALWAYS fix pre-existing bugs when working on a task and a pre-existing bug is identified, that should also be fixed as part of your task.

Run `task docs:embedme` after modifying this file to verify embedded content is current.
