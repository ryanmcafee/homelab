<div align="center">

# 🏠 Homelab

**This homelab needs no watering, no tending, so I can tend to what actually grows.**

_Watering plants together. Teaching small hands to be gentle. Ordinary lessons on ordinary days._

[![Kubernetes](https://img.shields.io/badge/k8s-v1.30.x-326CE5?logo=kubernetes&logoColor=white)](https://kubernetes.io/)
[![Talos](https://img.shields.io/badge/Talos-v1.7.x-FF6C2C?logo=talos&logoColor=white)](https://www.talos.dev/)
[![ArgoCD](https://img.shields.io/badge/ArgoCD-v2.11.x-EF7B4D?logo=argo&logoColor=white)](https://argoproj.github.io/cd/)
[![Proxmox](https://img.shields.io/badge/Proxmox-VE_9.x-E57000?logo=proxmox&logoColor=white)](https://www.proxmox.com/)
[![Terraform](https://img.shields.io/badge/Terraform-1.7.x-7B42BC?logo=terraform&logoColor=white)](https://www.terraform.io/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A GitOps-driven, family-first homelab monorepo using CNCF best practices.<br>
Single entrypoint setup, minimal ongoing maintenance, designed to run forever.

[Quick Start](#quick-start) • [Architecture](#architecture) • [Applications](#applications) • [Documentation](#documentation)

</div>

---

## ✨ Highlights

<table>
<tr>
<td width="50%">

### 🚀 Zero-Touch Operations
- **Single command setup** - from bare metal to production
- **Automated patching** via Renovate
- **Self-healing** infrastructure with Kubernetes

</td>
<td width="50%">

### 🔒 Enterprise-Grade Security
- **1Password integration** for secrets
- **GitOps** - single source of truth
- **Immutable infrastructure** with Talos Linux

</td>
</tr>
<tr>
<td width="50%">

### 🏗️ Production-Ready Stack
- **CNCF-neutral** open source technologies
- **Industry-standard** tools (Terraform, ArgoCD, K8s)
- **Multi-environment** support (localdev/homelab)

</td>
<td width="50%">

### 👨‍👩‍👧‍👦 Family-First Design
- **Plex** with GPU transcoding
- **Media automation** (Sonarr/Radarr)
- **Home automation** (Home Assistant)

</td>
</tr>
</table>

---

## 📊 Project Stats

```
📦 Total Storage: 160+ TB raw (RAIDZ3)      🧠 Memory: 256 GB ECC
⚡ CPU Cores: 24 vCPUs                       🎮 GPU: NVIDIA Quadro P2200 5GB
🌐 Services: 12+ applications                🔒 Security: 1Password + GitOps
🤖 Automation: Renovate + ArgoCD             📈 Uptime: Self-healing
```

---

## 🚀 Quick Start

### Prerequisites

This project uses [mise](https://mise.jdx.dev/) to manage all tool dependencies across Mac, Linux, and Windows.

**Mac/Linux:**
```bash
# Install mise
curl https://mise.run | sh

# Activate mise (add to ~/.bashrc or ~/.zshrc for persistence)
eval "$(~/.local/bin/mise activate bash)"
```

**Windows (PowerShell):**
```powershell
# Install mise
Invoke-Expression "& { $(Invoke-RestMethod https://mise.run) }"

# Activate mise (add to $PROFILE for persistence)
mise activate pwsh | Out-String | Invoke-Expression
```

### Quick Setup

**For Local Development (No Hardware Required):**
```bash
# Starts a local Kind cluster with all services
task localdev:up
```

**For Hardware Deployment (Dev/Prod):**

Prerequisites for hardware deployments:
- Proxmox installed and accessible
- SSH public key authentication configured for root user:
  ```bash
  # Copy your SSH public key to Proxmox host (replace with your Proxmox IP)
  ssh-copy-id root@${PROXMOX_HOST}

  # Test connection (should not prompt for password)
  ssh root@${PROXMOX_HOST}
  ```

Then run the automated setup:

**Mac/Linux:**
```bash
./scripts/setup.sh
```

**Windows:**
```powershell
.\scripts\setup.ps1
```

### Manual Installation

If you prefer to install tools manually:

```bash
mise install -y          # Install all tools from mise.toml
mise run validate        # Verify installations
mise doctor              # Troubleshoot issues
```

## Objectives

<details>
<summary><b>Click to expand design principles</b></summary>

- 🔧 Build a homelab using Terragrunt, Ansible, TrueNAS Scale, and Talos OS Kubernetes
- ⚡ Minimize manual steps and ongoing maintenance
- 📦 Use off-the-shelf open source technologies with preference for CNCF-neutral projects
- 🏢 Build a technology stack interchangeable with modern enterprise environments
- 🔄 Build around GitOps using the [GitOps Bridge pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- 🤖 Support automated patching and remediation via Renovate
- 📈 Support scale-out architecture (adding Proxmox cluster members in the future)
- 🩹 Support auto-recovery and self-healing
- 💾 Configure backup and recovery policies and procedures
- 📊 Configure comprehensive monitoring and observability using kube-prometheus-stack
- 🌍 Support multiple environments: localdev and homelab

</details>

---

## 🏗️ Architecture

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
│                    UniFi ←──BGP Peering──→ MetalLB                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 💡 Philosophy

> **Terraform builds the runway; ArgoCD flies the plane; Renovate keeps the engines updated; BGP routes the traffic.**

---

## 🛠️ Technology Stack

| Layer | Technology |
|-------|------------|
| Hypervisor | Proxmox VE 9.x |
| Storage | TrueNAS Scale 24.04.x |
| Kubernetes | Talos Linux 1.7.x / K8s 1.30.x |
| GitOps | ArgoCD 2.11.x |
| IaC | Terragrunt 0.55.x / Terraform 1.7.x |
| Configuration | Ansible 2.16.x |
| Secrets | 1Password + 1Password Operator |
| Load Balancer | MetalLB (BGP mode) |
| Ingress | Traefik |
| Observability | kube-prometheus-stack |
| Local Dev | Kind 0.22.x + Tilt 0.33.x |

---

## 💻 Hardware Specifications

> **Total Investment:** ~$6,000 | **RAM:** 256 GB | **Storage:** 160+ TB raw

### 🖥️ Proxmox Host

| Resource | Specification |
|----------|---------------|
| RAM | 256 GB |
| vCPUs | 24 total |
| GPU | HP NVIDIA Quadro P2200 5GB (passthrough for Plex) |
| OS Drive | 250GB NVMe |
| VM Storage | 2x 1TB NVMe (ZFS RAID-1 mirror) |
| HBA Card 1 | Broadcom 9400-8i (Proxmox storage) |
| HBA Card 2 | Broadcom 9400-8i Mixed Mode (TrueNAS passthrough) |

### 💾 TrueNAS Storage (HBA Passthrough)

| Resource | Specification |
|----------|---------------|
| Data Drives | 8x 20TB HDDs (RAIDZ3) |
| Special vDev | 2x 1TB NVMe (ZFS RAID-1 mirror for metadata + small blocks) |

**Parts List:** [Google Sheets](https://docs.google.com/spreadsheets/d/19JLS5aV629NgUacsKQQx_2HI5iXPV7Kn0e5kuBvYOVQ/edit?gid=0#gid=0)

### 🌐 Network Configuration

| Setting | Value |
|---------|-------|
| Base FQDN | ryanmcafee.com |
| Homelab VLAN | 100 |
| UniFi Controller | 172.16.100.1 |
| Proxmox Endpoint | 172.16.100.250 |
| IPMI Endpoint | 172.16.100.26 |
| Kubernetes Subnet | 172.16.100.0/24 |
| MetalLB Pool | 172.16.100.100-172.16.100.200 |
| BGP ASN (K8s) | 64512 |
| BGP ASN (UniFi) | 64513 |

---

## 📁 Directory Structure

```
homelab/
├── 🔧 ansible/                 # Proxmox configuration
├── 🏗️  terragrunt/              # Infrastructure as Code
│   ├── modules/              # Reusable Terraform modules
│   └── environments/         # localdev, homelab
├── 🐧 talos/                   # Talos Linux configuration
├── ⎈  charts/                  # Helm charts (GitOps)
│   ├── gitops/               # App of Apps umbrella
│   ├── addons/               # Core cluster addons
│   └── applications/         # User applications
├── 💻 localdev/                # Kind + Tilt local dev
├── 📚 docs/                    # Documentation
└── 🤖 scripts/                 # Automation scripts
```

---

## 📦 Managed Dependencies

All CLI tools are managed via mise (defined in `mise.toml`):

- **Infrastructure as Code**: Terraform 1.7.5, Terragrunt 0.55.1
- **Kubernetes Tools**: kubectl 1.30.0, Helm, Kind 0.22.0, Talos 1.7.6, Tilt 0.33.11
- **Configuration Management**: Ansible, ansible-lint (via pipx)
- **Task Runner**: Task (go-task)
- **Utilities**: jq, direnv, yamllint

External prerequisites (install separately):
- **Docker Desktop**: Required for local Kind development
- **Git, curl, wget**: System packages

---

## ⚙️ Tool Management

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
mise use terraform@1.8.0

# Remove unused versions
mise prune

# Troubleshoot issues
mise doctor
task mise:doctor
```

---

## 🔬 Local Development

Develop and test GitOps configurations without physical hardware:

```bash
# Start local Kind cluster + Tilt
task localdev:up

# Or start in ArgoCD mode (realistic GitOps simulation)
task localdev:tilt:argocd

# Tear down
task localdev:down
```

**URLs (when running locally):**
- ArgoCD: http://localhost:8080
- Traefik: http://localhost:9080
- Grafana: http://localhost:3000

---

## 📦 Applications

### 🔌 Addons (Core Infrastructure)

| Component | Purpose | Status |
|-----------|---------|--------|
| MetalLB | BGP load balancer | ⚡ Active |
| Traefik | Ingress controller | ⚡ Active |
| cert-manager | TLS certificates | ⚡ Active |
| external-dns | Cloudflare DNS automation | ⚡ Active |
| 1Password Operator | Secrets management | ⚡ Active |
| kube-prometheus-stack | Observability & monitoring | ⚡ Active |
| democratic-csi | TrueNAS storage provisioning | ⚡ Active |

### User Applications

| Application | Purpose | Features |
|-------------|---------|----------|
| **Plex** | Media server | GPU transcoding, remote access |
| **Sonarr/Radarr** | Media automation | Automated downloads, organization |
| **Prowlarr** | Indexer management | Centralized search |
| **Home Assistant** | Home automation | Smart home control, automation |
| **Mosquitto** | MQTT broker | IoT device messaging |

---

## 🔧 Hardware Setup Notes

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

## 🎨 Design Patterns

| Pattern | Implementation |
|---------|----------------|
| **🌉 GitOps Bridge** | Terraform bootstraps ArgoCD, then hands off control |
| **📱 App of Apps** | ArgoCD manages applications hierarchically |
| **📦 Monorepo** | Single source of truth for all infrastructure |
| **⚖️ Environment Parity** | localdev/homelab use same charts with different values |

---

## 📚 Documentation

See [plan.md](./plan.md) for the complete implementation plan including:
- Detailed phase-by-phase implementation guide
- Terraform/Terragrunt module specifications
- Helm chart configurations
- Ansible playbook details
- Acceptance criteria for each phase

## 🔗 References

- 🌉 [GitOps Bridge Pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- 🐧 [Talos on Proxmox with OpenTofu](https://blog.stonegarden.dev/articles/2024/08/talos-proxmox-tofu/)
- ⎈ [TrueCharts Helm Repository](https://github.com/truecharts/charts)
- 🐳 [Kind - Kubernetes in Docker](https://kind.sigs.k8s.io/)
- 🚀 [Tilt - Local Kubernetes Development](https://tilt.dev/)

---

<div align="center">

### 💝 Built for what actually grows

**This homelab needs no watering, no tending,**
**so I can tend to what actually grows.**

_Watering plants together. Teaching small hands to be gentle. Ordinary lessons on ordinary days._

</div>
# CI Test
