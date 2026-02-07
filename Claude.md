# Homelab Project - Claude AI Instructions

Read `AGENTS.md` and apply the rules to all subagents.
When implementing plans, always analyze the plan first and look for opportunities to use sub agents.
Before implementing a plan, ensure that 'bd' is used for task tracking to support saving progress and context for long running tasks.

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

## Local Configuration

For environment-specific settings (IP addresses, hostnames, credentials), see `CLAUDE.local.md`.
Copy from `CLAUDE.local.md.example` and customize for your environment.

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

### Current Versions (Auto-embedded from values.yaml)

**Infrastructure Charts** - `charts/addons/values.yaml`:

ArgoCD:
<!-- embedme charts/addons/values.yaml#L53-L56 -->
```yaml
chart:
  name: argo-cd
  repo: https://argoproj.github.io/argo-helm
  version: "7.7.15"
```

Kubelet CSR Approver:
<!-- embedme charts/addons/values.yaml#L234-L237 -->
```yaml
chart:
  name: kubelet-csr-approver
  repo: https://postfinance.github.io/kubelet-csr-approver
  version: "1.2.2"
```

Democratic-CSI:
<!-- embedme charts/addons/values.yaml#L258-L261 -->
```yaml
chart:
  name: democratic-csi
  repo: https://democratic-csi.github.io/charts/
  version: 0.14.6
```

Cert-Manager:
<!-- embedme charts/addons/values.yaml#L392-L395 -->
```yaml
chart:
  name: cert-manager
  repo: https://charts.jetstack.io
  version: v1.16.2
```

External-DNS:
<!-- embedme charts/addons/values.yaml#L460-L463 -->
```yaml
chart:
  name: external-dns
  repo: https://kubernetes-sigs.github.io/external-dns/
  version: 1.15.0
```

Kube-Prometheus-Stack:
<!-- embedme charts/addons/values.yaml#L504-L507 -->
```yaml
chart:
  name: kube-prometheus-stack
  repo: https://prometheus-community.github.io/helm-charts
  version: 69.8.2
```

Traefik:
<!-- embedme charts/addons/values.yaml#L626-L629 -->
```yaml
chart:
  name: traefik
  repo: https://traefik.github.io/charts
  version: 39.0.0
```

**Application Charts** - `charts/applications/values.yaml`:

Plex:
<!-- embedme charts/applications/values.yaml#L63-L66 -->
```yaml
chart:
  name: plex-media-server
  repo: https://raw.githubusercontent.com/plexinc/pms-docker/gh-pages
  version: 1.4.0
```

Sonarr:
<!-- embedme charts/applications/values.yaml#L181-L184 -->
```yaml
chart:
  name: sonarr
  repo: https://trueforge-org.github.io/truecharts
  version: 25.2.11
```

Radarr:
<!-- embedme charts/applications/values.yaml#L259-L262 -->
```yaml
chart:
  name: radarr
  repo: https://trueforge-org.github.io/truecharts
  version: 26.3.11
```

Prowlarr:
<!-- embedme charts/applications/values.yaml#L336-L339 -->
```yaml
chart:
  name: prowlarr
  repo: https://trueforge-org.github.io/truecharts
  version: 21.3.12
```

Home Assistant:
<!-- embedme charts/applications/values.yaml#L710-L713 -->
```yaml
chart:
  name: home-assistant
  repo: https://trueforge-org.github.io/truecharts
  version: 28.19.14
```

Mosquitto:
<!-- embedme charts/applications/values.yaml#L778-L781 -->
```yaml
chart:
  name: mosquitto
  repo: https://trueforge-org.github.io/truecharts
  version: 17.13.9
```

### Version Update Files
When updating a chart version, modify these files:
1. `charts/addons/values.yaml` - Infrastructure charts
2. `charts/addons/values-homelab.yaml` - Homelab overrides (if different)
3. `charts/applications/values.yaml` - Application charts
4. `charts/applications/values-homelab.yaml` - Homelab overrides (if different)

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
- Wave -2: SOPS secrets (1Password credentials)
- Wave -1: Namespaces
- Wave 0: 1Password Operator
- Wave 1-2: CSR approver, Cilium LB IPAM, Democratic-CSI
- Wave 3-4: cert-manager, external-dns
- Wave 5-6: kube-prometheus-stack, Traefik
- Wave 7+: Applications

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
