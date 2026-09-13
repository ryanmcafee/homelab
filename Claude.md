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

This project has 25 specialized subagents in `.claude/agents/`. **Always delegate to the appropriate subagent** instead of doing specialized work inline. See `AGENTS.md` for the full list and coordination rules.

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
| **TypeScript/Deno scripts** | `typescript-pro` | Deno runtime, scripting patterns |
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
| Non-interactive shells miss the mise shims | Prepend `$HOME/.local/share/mise/shims` to `PATH` (`go`, `helm`, `deno`, `task` are all mise-managed; `mise.toml` pins `go = "1.25"` and `helm = "4.2.0"`). |
| helm version changes rendered bytes | Golden snapshots are byte-exact against `configuration/versions.yaml` `tools.helm`; keep `mise.toml`, `verify.yml` and `versions.yaml` on the same helm. |
| `go run ./cmd/homelab` collapses child exit codes to 1 | Check exit codes with the built binary (`go build -o bin/homelab ./cmd/homelab`). |
| Terraform warns about the plugin cache dir | `task install-tools` creates `.terraform.d/plugin-cache` (the path `mise.toml` sets in `TF_PLUGIN_CACHE_DIR`). |
| Docker Desktop is slow to start; CMP image tags before PR #264 are linux/amd64 only | `open -a Docker` and wait; on Apple Silicon run `task test:cmp-parity -- --platform linux/amd64` for old tags. |
| `git push` over HTTPS occasionally fails ("remote end hung up", transient DNS) | Retry with `git -c http.version=HTTP/1.1 push`. |
| `tests/snapshots/` must stay byte-exact | yamllint and the whitespace pre-commit fixers exclude it; regenerate with `task test:snapshot -- --update`, never hand-edit. |
| `eza`, `fd`, `bat` are not installed | Use `rg` (`rg --files` for listing). |

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
| `task config:guard` | Scan staged files for PII |

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
- TypeScript scripting only (Deno runtime, no Bash/Python)
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
| kubelet-csr-approver | https://github.com/postfinance/kubelet-csr-approver/blob/main/charts/kubelet-csr-approver/Chart.yaml |
| oauth2-proxy | https://github.com/oauth2-proxy/manifests/blob/main/helm/oauth2-proxy/Chart.yaml |
| nvidia-gpu-operator | https://github.com/NVIDIA/gpu-operator/blob/main/deployments/gpu-operator/Chart.yaml |
| Plex | https://github.com/plexinc/pms-docker/blob/master/charts/plex-media-server/Chart.yaml |
| TrueCharts | https://github.com/trueforge-org/truecharts/tree/master/charts/stable/{chart-name}/Chart.yaml |

### Current Versions (Auto-embedded from configuration/versions.yaml)

`configuration/versions.yaml` is the single source of truth for every chart, image and tool
version and the only file Renovate bumps. The homelab environment receives these versions at
render time through the CMP (`homelab config export`), so the `chart.version` values in
`charts/*/values.yaml` are placeholders that lag this file (tracked in #263).

```yaml
<!-- embedme configuration/versions.yaml -->
```

### Version Update Files
To update a chart, image or tool version:
1. Edit `configuration/versions.yaml` (or let Renovate do it).
2. If the chart ships CRDs, run `task schemas:vendor` and commit `tests/schemas/`.
3. Run `task verify:text`, then `task test:snapshot -- --update` and commit the snapshots.

Do not edit `chart.version` in `charts/*/values.yaml`; those values are overridden by the CMP in homelab.

## Project Structure

```
homelab/
├── charts/
│   ├── gitops/           # App-of-Apps bootstrap
│   ├── addons/           # Infrastructure (18 templates)
│   │   ├── values.yaml   # Base values with all chart versions
│   │   └── values-homelab.yaml
│   ├── applications/     # User workloads (9 templates)
│   └── secrets/          # SOPS-encrypted secrets
├── scripts/              # TypeScript automation (Deno)
│   ├── talos-node-recreate.ts
│   ├── verify-gpu-support.ts
│   ├── sops-bootstrap.ts
│   └── sops-setup-onepassword.ts
├── terragrunt/
│   ├── modules/          # Reusable Terraform modules
│   └── environments/     # homelab + localdev
├── localdev/             # Kind + Tilt configuration
├── talos/                # Talos Linux config + image
└── docs/                 # Architecture + runbooks
```

## Taskfile Quick Reference

Run `task --list` for full list. Most commonly used:

| Command | Description |
|---------|-------------|
| `task localdev:up` | Start Kind + Tilt local development |
| `task localdev:down` | Destroy local environment |
| `task verify` | Level-0 static verification: render, kubeconform, gitops graph, snapshots, policy (JSON, < 5 s) |
| `task verify:text` | Level-0 verification, human-readable |
| `task test:snapshot -- --update` | Regenerate golden snapshots in `tests/snapshots/` |
| `task test:policy` | conftest policy unit tests + negative fixtures |
| `task schemas:vendor` | Re-vendor CRD JSON schemas from `versions.yaml` pins |
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
- Wave 0: Bootstrap (SOPS secrets, 1Password operator, config secret)
- Wave 2: Addons (Core infrastructure — via CMP plugin in homelab)
- Wave 3: Applications (User workloads — via CMP plugin in homelab)

### CMP Architecture
The homelab environment uses an ArgoCD Config Management Plugin (CMP) sidecar to generate environment-specific Helm values at runtime, eliminating PII from committed files.

- **Bootstrap chart** deploys: SOPS secrets, 1Password operator, homelab-environment-config secret
- **CMP sidecar** runs `homelab config export --stdout` piped into `helm template`
- **Localdev** continues using native Helm with `values-localdev.yaml` (no CMP)
- Design doc: `docs/plans/2026-02-11-argocd-cmp-pii-removal-design.md`

### Common Errors & Solutions
| Error | Cause | Solution |
|-------|-------|----------|
| "OnePasswordItem not found" | 1Password Operator not ready | Check sync wave ordering |
| "Unable to find valid certification path" | TrueNAS TLS not trusted | Democratic-CSI uses allowInsecure |
| "dry run failed" | Server-side apply conflicts | Add ServerSideApply=true to syncOptions |
| Ingress "Progressing" forever | No LoadBalancer IP | Custom health check marks Ingress Healthy |

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

All scripts use Deno with explicit permissions:
```typescript
#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read
```

Conventions:
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
