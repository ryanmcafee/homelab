# Homelab

Built with care, designed for presence. "One more story?" Always yes. This homelab was built so the answer is always yes.

A GitOps-driven, family-first homelab monorepo using CNCF best practices. Single entrypoint setup, zero ongoing maintenance, designed to run forever.

## Quick Start

```bash
# Local development (no hardware required)
task localdev:up

# Production deployment
./scripts/setup.sh
```

## Objectives

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
- Support multiple environments: localdev, dev, and production

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
│                    UniFi ←──BGP Peering──→ MetalLB                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Terraform builds the runway; ArgoCD flies the plane; Renovate keeps the engines updated; BGP routes the traffic.**

## Technology Stack

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

## Hardware Specifications

### Proxmox Host

| Resource | Specification |
|----------|---------------|
| RAM | 256 GB |
| vCPUs | 24 total |
| GPU | HP NVIDIA Quadro P2200 5GB (passthrough for Plex) |
| OS Drive | 250GB NVMe |
| VM Storage | 2x 1TB NVMe (ZFS RAID-1 mirror) |
| HBA Card 1 | Broadcom 9400-8i (Proxmox storage) |
| HBA Card 2 | Broadcom 9400-8i Mixed Mode (TrueNAS passthrough) |

### TrueNAS Storage (HBA Passthrough)

| Resource | Specification |
|----------|---------------|
| Data Drives | 8x 20TB HDDs (RAIDZ2) |
| Special vDev | 2x 1TB NVMe (ZFS RAID-1 mirror for metadata + small blocks) |

**Parts List:** [Google Sheets](https://docs.google.com/spreadsheets/d/19JLS5aV629NgUacsKQQx_2HI5iXPV7Kn0e5kuBvYOVQ/edit?gid=0#gid=0)

### Network Configuration

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

## Directory Structure

```
homelab/
├── ansible/                 # Proxmox configuration
├── terragrunt/              # Infrastructure as Code
│   ├── modules/             # Reusable Terraform modules
│   └── environments/        # localdev, dev, prod
├── talos/                   # Talos Linux configuration
├── charts/                  # Helm charts (GitOps)
│   ├── gitops/              # App of Apps umbrella
│   ├── addons/              # Core cluster addons
│   └── applications/        # User applications
├── localdev/                # Kind + Tilt local dev
├── docs/                    # Documentation
└── scripts/                 # Automation scripts
```

## Local Development

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

## Applications

### Addons (Core Infrastructure)
- MetalLB (BGP load balancer)
- Traefik (Ingress controller)
- cert-manager (TLS certificates)
- external-dns (Cloudflare DNS)
- 1Password Operator (Secrets)
- kube-prometheus-stack (Observability)
- democratic-csi (TrueNAS storage)

### User Applications
- Plex (GPU-accelerated transcoding)
- Sonarr, Radarr, Prowlarr (Media management)
- Home Assistant (Home automation)
- Mosquitto (MQTT broker)

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

## Design Patterns

- **GitOps Bridge Pattern** - Terraform bootstraps ArgoCD, then hands off control
- **App of Apps** - ArgoCD manages applications hierarchically
- **Monorepo Architecture** - Single source of truth for all infrastructure
- **Environment Parity** - localdev/dev/prod use same charts with different values

## Documentation

See [plan.md](./plan.md) for the complete implementation plan including:
- Detailed phase-by-phase implementation guide
- Terraform/Terragrunt module specifications
- Helm chart configurations
- Ansible playbook details
- Acceptance criteria for each phase

## References

- [GitOps Bridge Pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- [Talos on Proxmox with OpenTofu](https://blog.stonegarden.dev/articles/2024/08/talos-proxmox-tofu/)
- [TrueCharts Helm Repository](https://github.com/truecharts/charts)
- [Kind - Kubernetes in Docker](https://kind.sigs.k8s.io/)
- [Tilt - Local Kubernetes Development](https://tilt.dev/)
