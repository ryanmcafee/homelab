# Homelab Project Overview

## Purpose
GitOps-driven homelab infrastructure managing a Talos Linux Kubernetes cluster on Proxmox VE. Uses ArgoCD App-of-Apps pattern for deployment orchestration, with multi-environment support (localdev via Kind+Tilt, homelab for production).

## Tech Stack
- **Languages**: Go (CLI tooling), TypeScript (Deno scripts), Terraform/Terragrunt (IaC), Helm (Kubernetes charts)
- **Go CLI**: `cmd/homelab/` - Cobra-based CLI with subcommands (bootstrap, render, sops, talos, validate, verify)
- **Go Libraries**: `spf13/cobra` (CLI), `fatih/color` (terminal colors)
- **Infrastructure**: Proxmox VE, Talos Linux, Cilium CNI, ArgoCD, 1Password+SOPS for secrets
- **Task Runner**: Taskfile (not Make)
- **Tool Management**: mise (manages terraform, kubectl, helm, deno, etc.)
- **Scripting Runtime**: Deno (TypeScript only, no Bash/Python scripts)

## Architecture
- ArgoCD App-of-Apps: `charts/gitops` → `charts/addons` (infra) → `charts/applications` (workloads)
- Sync waves: -2 (SOPS secrets) → -1 (namespaces) → 0 (1Password) → 1-7+ (services)
- Terragrunt modules: proxmox-vm, talos-cluster, talos-image, kind-cluster, gitops-bootstrap, truenas, unifi-gateway
- Two environments: `terragrunt/environments/homelab/` and `terragrunt/environments/localdev/`

## Key Directories
```
cmd/homelab/          - Go CLI (cobra commands)
internal/             - Go internal packages (logger, config, template, utils)
charts/addons/        - Infrastructure Helm chart (25 templates)
charts/applications/  - Application Helm chart (15 templates)
charts/gitops/        - App-of-Apps bootstrap
charts/secrets/       - SOPS-encrypted secrets
terragrunt/modules/   - 11 Terraform modules
terragrunt/environments/ - homelab + localdev configs
scripts/              - Deno TypeScript automation scripts
talos/                - Talos Linux machine configs and patches
localdev/             - Kind + Tilt local dev config
docs/                 - Architecture docs and runbooks
```
