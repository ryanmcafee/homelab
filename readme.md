<div align="center">

# Homelab

[![Kubernetes](https://img.shields.io/badge/k8s-v1.36.x-326CE5?logo=kubernetes&logoColor=white)](https://kubernetes.io/)
[![Talos](https://img.shields.io/badge/Talos-v1.13.x-FF6C2C?logo=talos&logoColor=white)](https://www.talos.dev/)
[![ArgoCD](https://img.shields.io/badge/ArgoCD-v3.4.x-EF7B4D?logo=argo&logoColor=white)](https://argoproj.github.io/cd/)
[![Proxmox](https://img.shields.io/badge/Proxmox-VE_9.x-E57000?logo=proxmox&logoColor=white)](https://www.proxmox.com/)
[![Terragrunt](https://img.shields.io/badge/Terragrunt-1.0.x-7B42BC?logo=terraform&logoColor=white)](https://terragrunt.gruntwork.io/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A GitOps-driven homelab monorepo using CNCF best practices.<br>
Single entrypoint setup, minimal ongoing maintenance, designed to run forever.

[Quick Start](#quick-start) • [Architecture](#architecture) • [Applications](#applications) • [Documentation](#documentation)

</div>

---

## Highlights

<table>
<tr>
<td width="50%">

### Zero-Touch Operations
- **Single command setup** - from bare metal to production
- **Automated patching** via Renovate
- **Self-healing** infrastructure with Kubernetes

</td>
<td width="50%">

### Enterprise-Grade Security
- **1Password + SOPS** for secrets management
- **GitOps** - single source of truth
- **Immutable infrastructure** with Talos Linux

</td>
</tr>
<tr>
<td width="50%">

### Production-Ready Stack
- **CNCF-neutral** open source technologies
- **Industry-standard** tools (Terragrunt, ArgoCD, K8s)
- **Multi-environment** support (localdev/homelab)

</td>
<td width="50%">

### Media & Home Automation
- **Plex** with GPU transcoding
- **Media automation** (Sonarr/Radarr)
- **Home automation** (Home Assistant)

</td>
</tr>
</table>

---

## Quick Start

### Prerequisites

#### Install mise

This project uses [mise](https://mise.jdx.dev/) to manage all tool dependencies.

```bash
# Install mise
curl https://mise.run | sh

# Activate mise (add to ~/.bashrc or ~/.zshrc for persistence)
eval "$(~/.local/bin/mise activate bash)"

# Install all tools
mise install
```

#### Set up SSH keys

Configure SSH public key authentication for the Proxmox root user:

```bash
# Copy your SSH public key to Proxmox host
ssh-copy-id root@${PROXMOX_HOST}

# Test connection (should not prompt for password)
ssh root@${PROXMOX_HOST}
```

#### Set up 1Password

Authenticate the 1Password CLI:

```bash
eval $(op signin)
```

#### Set up SOPS

Bootstrap SOPS encryption with age keys stored in 1Password:

```bash
task sops:bootstrap    # Generate age keys, store in 1Password
task sops:setup        # Pull credentials, encrypt, commit
```

### Build the CLI

```bash
go build -o bin/homelab ./cmd/homelab
```

### Bootstrap the Environment

```bash
./bin/homelab bootstrap
```

Available CLI commands:

```bash
homelab --help
homelab validate        # Check prerequisites
homelab sops bootstrap  # Setup SOPS encryption
homelab sops setup      # Pull credentials from 1Password
homelab bootstrap       # Full environment setup
homelab talos recreate  # Recreate Talos nodes
homelab verify gpu      # Verify GPU support
homelab config validate # Validate schemas + environment values
homelab config eval     # Resolve and print config as JSON
homelab config export   # Export all consumer formats
homelab config guard    # Scan staged files for PII
homelab verify all --level 0|1|2  # Static verification; + Kind dry run; + ArgoCD health and e2e (task verify)

# All commands support --dry-run and --help
homelab bootstrap --dry-run --yes
```

## Objectives

<details>
<summary><b>Click to expand design principles</b></summary>

- Build a homelab using Terragrunt, Ansible, TrueNAS Scale, and Talos OS Kubernetes
- Minimize manual steps and ongoing maintenance
- Use off-the-shelf open source technologies with preference for CNCF-neutral projects
- Build a technology stack interchangeable with modern enterprise environments
- Build around GitOps using the [GitOps Bridge pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- Support automated patching and remediation via Renovate
- Support scale-out architecture (adding Proxmox cluster members in the future)
- Support auto-recovery and self-healing
- Configure backup and recovery policies and procedures
- Configure comprehensive monitoring and observability using kube-prometheus-stack
- Support multiple environments: localdev and homelab

</details>

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GitHub Repository                               │
│                    (Single Source of Truth - GitOps)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Renovate (Automated Updates)  │  GitHub Actions (CI/CD)  │  1Password      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Infrastructure Stack                                 │
│                                                                              │
│   Proxmox ──► TrueNAS Scale ──► Talos Linux ──► ArgoCD ──► Applications    │
│  (Ansible)     (Terragrunt)    (Terragrunt)   (GitOps)     (Helm Charts)   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Software Defined Networking                          │
│                    UniFi ←──BGP Peering──→ Cilium                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Philosophy

> **Terragrunt builds the runway; ArgoCD flies the plane; Renovate keeps the engines updated; BGP routes the traffic.**

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Hypervisor | Proxmox VE 9.x |
| Storage | TrueNAS Scale 24.04.x |
| Kubernetes | Talos Linux 1.13.x / K8s 1.36.x |
| GitOps | ArgoCD 3.4.x (argo-cd chart 9.5.x) |
| IaC | Terragrunt 1.0.x / Terraform 1.15.x |
| Configuration | Ansible 2.16.x |
| Secrets | 1Password + SOPS (age encryption) |
| Load Balancer | Cilium (BGP mode) |
| Ingress | Traefik |
| Observability | kube-prometheus-stack |
| Local Dev | Kind 0.33.x + Cilium + ArgoCD (`argocd app sync --local`), Tilt 0.37.x optional |
| Verification | `homelab verify` levels 0-2: helm + kubeconform + conftest, Kind dry run, Chainsaw 0.2.x e2e |

---

## Managed Dependencies

All CLI tools are managed via mise (defined in `mise.toml`):

- **Infrastructure as Code**: Terraform 1.15.5, Terragrunt 1.0.8
- **Kubernetes Tools**: kubectl 1.36.x, Helm 4.2.0, Kind 0.33.0, Talos 1.13.x, ArgoCD CLI 3.5.2, Tilt 0.37.3
- **Verification**: kubeconform, conftest, pluto, Chainsaw 0.2.15 (`configuration/versions.yaml` is the source of truth for the pinned ones)
- **Configuration Management**: Ansible, ansible-lint (via pipx)
- **Task Runner**: Task (go-task); scripts run on Deno
- **Secrets**: age, sops, op (1Password CLI)
- **Utilities**: jq, yq, direnv, yamllint, pre-commit

External prerequisites (install separately):
- **Docker Desktop**: Required for local Kind development
- **Git, curl, wget**: System packages

---

## Tool Management

All tools are managed via [mise](https://mise.jdx.dev/) and defined in `mise.toml`. Versions are pinned for consistency across environments.

```bash
# List installed tools and versions
mise ls
task mise:list

# Check for outdated tools
mise ls --outdated
task mise:outdated

# Upgrade all tools
mise upgrade
task mise:upgrade

# Switch to a specific version
mise use terragrunt@0.55.1

# Remove unused versions
mise prune

# Troubleshoot issues
mise doctor
task mise:doctor
```

---

## Secrets Management

Secrets are managed using SOPS with age encryption, stored in Git, and decrypted at deploy time by ArgoCD.

```bash
# Bootstrap SOPS (one-time setup)
task sops:bootstrap          # Generate age keys, store in 1Password

# Setup 1Password credentials (automated)
task sops:setup              # Pull from 1Password, encrypt, commit

# Day-to-day operations
task sops:edit               # Edit encrypted secrets
task sops:decrypt            # View decrypted secrets
task sops:verify             # Verify decryption works
task sops:rotate             # Rotate encryption keys
```

**Architecture:**
- Age private key stored in 1Password (`homelab/sops-age-key`)
- Age public key configured in `.sops.yaml`
- Encrypted secrets committed to Git (`charts/secrets/`)
- ArgoCD decrypts via ksops plugin at deploy time

See [charts/secrets/README.md](./charts/secrets/README.md) for detailed documentation.

---

## Configuration System

All environment-specific values (IPs, domains, hostnames, credentials paths) are centralized in `configuration/` and exported to consumer formats (Helm values, tfvars, dotenv, JSON) via a Go-based pipeline.

```bash
# Validate schemas and environment values
task config:validate

# Resolve and print all configuration as JSON
task config:eval

# Export all consumer formats (Helm, tfvars, dotenv, JSON)
task config:export

# Scan staged files for PII leakage
task config:guard
```

**Key directories:**

| Path | Purpose |
|------|---------|
| `configuration/schema/` | Key declarations (committed) |
| `configuration/environments/` | Defaults + per-environment overrides |
| `configuration/templates/` | Export format templates (Go text/template) |
| `configuration/versions.yaml` | All chart/tool versions (committed) |

**How it works:**
1. **Schema** files declare all configuration keys with types and defaults
2. **Environment** files provide values per environment (homelab, localdev)
3. **Eval** resolves the hierarchy (schema defaults → shared defaults → environment)
4. **Export** renders resolved values through templates into consumer formats
5. **Guard** scans for PII patterns to prevent accidental commits of sensitive values

A pre-commit hook runs `config guard` automatically, and a CI workflow validates schemas on every push.

---

## Local Development

Run the whole GitOps stack on a Kind cluster and sync the working tree into it; nothing
touches the homelab cluster.

```bash
task localdev:up            # Kind (Cilium, registry caches, fakes) + ArgoCD + every Application synced from the working tree
task localdev:sync          # push the working tree again after an edit (-- --only <app> for one)
task verify:text LEVEL=2    # level 0 + Kind dry run + every Application Healthy + chainsaw e2e
task localdev:diagnose      # conditions, events, failing pod logs
task localdev:down          # delete the cluster (registry caches are kept)

task localdev:tilt:argocd   # optional: Tilt wraps the loop and re-syncs on every chart change
```

**URLs (when running locally):**
- ArgoCD: http://localhost:8080 (`admin`; password in `argocd-initial-admin-secret`); on macOS run `task localdev:ui` first (Kind host port mappings do not work there with Cilium)
- Applications: in-cluster through Traefik with `Host: <app>.homelab.local`, or `kubectl port-forward`

See [docs/local-development.md](./docs/local-development.md) and
[docs/runbooks/verification.md](./docs/runbooks/verification.md).

---

## Applications

### Addons (Core Infrastructure)

| Component | Purpose | Status |
|-----------|---------|--------|
| Cilium | BGP Peering/CNI | Active |
| Traefik | Ingress controller | Active |
| cert-manager | TLS certificates | Active |
| external-dns | Cloudflare DNS automation | Active |
| 1Password Operator | Secrets management | Active |
| kube-prometheus-stack | Observability & monitoring | Active |
| democratic-csi | TrueNAS storage provisioning | Active |

### User Applications

| Application | Purpose | Features |
|-------------|---------|----------|
| **Plex** | Media server | GPU transcoding, remote access |
| **Sonarr/Radarr** | Media automation | Automated downloads, organization |
| **Prowlarr** | Indexer management | Centralized search |
| **Home Assistant** | Home automation | Smart home control, automation |
| **Mosquitto** | MQTT broker | IoT device messaging |

---

## Hardware Setup Notes

### Broadcom HBA Firmware (Mixed Mode for NVMe)

The Broadcom 9400-8i HBA requires firmware update for mixed mode NVMe support.

**Required Cables (U.2 NVMe):**
| MPN | Length | Description |
|-----|--------|-------------|
| 05-50065-00 | 0.5m | SFF-8643 to SFF-8639 |
| 05-50064-00 | 1.0m | SFF-8643 to SFF-8639 |

**Reference:** https://docs.broadcom.com/doc/12354774

### IPMI Fan Threshold (Supermicro + Noctua)

Noctua fans on Supermicro servers experience cyclical spin-up. Fix by adjusting IPMI thresholds:

```bash
ipmitool sensor thresh FAN1 lower 200 300 400
```

**Reference:** https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/

---

## Design Patterns

| Pattern | Implementation |
|---------|----------------|
| **GitOps Bridge** | Terragrunt bootstraps ArgoCD, then hands off control |
| **App of Apps** | ArgoCD manages applications hierarchically |
| **Monorepo** | Single source of truth for all infrastructure |
| **Environment Parity** | localdev/homelab use same charts with different values |
| **Centralized Config** | Single schema-driven pipeline exports to all consumer formats |

---


## References

- [GitOps Bridge Pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- [Talos on Proxmox with OpenTofu](https://blog.stonegarden.dev/articles/2024/08/talos-proxmox-tofu/)
- [TrueCharts Helm Repository](https://github.com/truecharts/charts)
- [Kind - Kubernetes in Docker](https://kind.sigs.k8s.io/)
- [Tilt - Local Kubernetes Development](https://tilt.dev/)

---
