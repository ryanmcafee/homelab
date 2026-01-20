# Homelab Architecture Documentation

**This homelab needs no watering, no tending, so I can tend to what actually grows.**

_Watering plants together. Teaching small hands to be gentle. Ordinary lessons on ordinary days._

This document provides a comprehensive overview of the homelab architecture, design patterns, and technical implementation details.

## Table of Contents

- [Overview](#overview)
- [Architecture Principles](#architecture-principles)
- [Infrastructure Layers](#infrastructure-layers)
- [Technology Stack](#technology-stack)
- [GitOps Bridge Pattern](#gitops-bridge-pattern)
- [Network Architecture](#network-architecture)
- [Storage Architecture](#storage-architecture)
- [Compute Architecture](#compute-architecture)
- [Application Deployment](#application-deployment)
- [Security Architecture](#security-architecture)
- [Monitoring and Observability](#monitoring-and-observability)
- [Disaster Recovery](#disaster-recovery)
- [Environment Strategy](#environment-strategy)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

This homelab is a production-grade, GitOps-driven infrastructure platform built on enterprise technologies with a focus on automation, reliability, and zero maintenance overhead.

### Design Philosophy

- **Single Entrypoint**: One script to rule them all (`./scripts/setup.sh`)
- **Zero Maintenance**: Automated updates via Renovate, self-healing via ArgoCD
- **Family First**: Built to run forever so the answer is always "yes" to bedtime stories
- **Production Patterns**: Uses the same patterns and tools as modern enterprises
- **Infrastructure as Code**: Everything in Git, nothing manual

### High-Level Architecture

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

**Philosophy**: Terraform builds the runway; ArgoCD flies the plane; Renovate keeps the engines updated; BGP routes the traffic.

---

## Architecture Principles

### 1. GitOps-First

Every infrastructure change flows through Git:
- **Declarative Configuration**: All infrastructure defined in YAML/HCL
- **Version Control**: Complete audit trail of all changes
- **Automated Reconciliation**: ArgoCD continuously syncs desired state
- **Single Source of Truth**: Git is the authoritative source

### 2. Immutable Infrastructure

- **Talos Linux**: Immutable OS designed for Kubernetes
- **Container-Native**: All applications run in containers
- **Declarative Nodes**: Node configuration is API-driven, not SSH-based
- **Predictable Updates**: Atomic OS upgrades with rollback capability

### 3. Self-Healing

- **ArgoCD Sync**: Automatically corrects drift from desired state
- **Kubernetes Controllers**: Built-in reconciliation loops
- **Automated Remediation**: Failed pods restart automatically
- **Health Checks**: Liveness and readiness probes

### 4. Automated Updates

- **Renovate Bot**: Automatically opens PRs for dependency updates
- **Semantic Versioning**: Patch updates auto-merge, minor/major require review
- **Multi-Layer Updates**: Updates Helm charts, container images, Terraform providers
- **Continuous Integration**: GitHub Actions validates all changes

### 5. Scale-Out Ready

- **Horizontal Scaling**: Add Proxmox nodes to cluster
- **Distributed Storage**: Ceph/ZFS can scale across nodes
- **Kubernetes Scaling**: Add worker nodes as needed
- **BGP Peering**: Automatically announces new service IPs

### 6. Environment Parity

- **Same Charts Everywhere**: localdev, homelab use identical Helm charts
- **Values-Based Differentiation**: Only values files differ per environment
- **Local Development**: Full GitOps stack runs on laptop via Kind
- **Consistent Behavior**: Reduces "works on my machine" issues

---

## Infrastructure Layers

### Layer 1: Hypervisor (Proxmox VE)

**Purpose**: Bare-metal virtualization platform

```
┌─────────────────────────────────────────────────────────────────┐
│                        Proxmox VE 9.x                            │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  TrueNAS VM  │  │ Talos CP-1   │  │ Talos CP-2   │         │
│  │  (HBA Pass)  │  │ (K8s Master) │  │ (K8s Master) │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │Talos Worker-1│  │Talos Worker-2│  │Talos Worker-3│         │
│  │  (GPU Pass)  │  │              │  │              │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

**Key Features**:
- ZFS RAID-1 mirror for VM storage (2x 1TB NVMe)
- HBA passthrough for TrueNAS (Broadcom 9400-8i)
- GPU passthrough for Plex (NVIDIA Quadro P2200)
- Web UI for VM management
- Ansible-managed post-install configuration

**Configuration Management**: Ansible playbooks in `ansible/`

### Layer 2: Storage (TrueNAS Scale)

**Purpose**: Enterprise storage with NFS/iSCSI provisioning

```
┌─────────────────────────────────────────────────────────────────┐
│                      TrueNAS Scale 24.04.x                       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ZFS Pool (RAIDZ3)                                        │  │
│  │  - Data: 8x 20TB HDDs                                     │  │
│  │  - Special vDev: 2x 1TB NVMe (metadata + small blocks)   │  │
│  │  - Total Usable: ~120TB                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  NFS Shares → democratic-csi → Kubernetes PVCs                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key Features**:
- RAIDZ3 for dual-disk fault tolerance
- Special vDev for metadata acceleration
- NFS shares for Kubernetes persistent volumes
- Snapshots and replication for backups
- HBA passthrough for direct disk access

**Provisioning**: Terragrunt module `terragrunt/modules/truenas/`

### Layer 3: Compute (Talos Linux + Kubernetes)

**Purpose**: Container orchestration platform

```
┌─────────────────────────────────────────────────────────────────┐
│                    Talos Linux 1.7.x / K8s 1.30.x                │
│                                                                  │
│  Control Plane (2 nodes)          Workers (3 nodes)             │
│  ┌──────────────────┐             ┌──────────────────┐         │
│  │ talos-cp-1       │             │ talos-worker-1   │         │
│  │ - etcd           │             │ - Plex (GPU)     │         │
│  │ - api-server     │             │ - Media apps     │         │
│  │ - scheduler      │             └──────────────────┘         │
│  └──────────────────┘             ┌──────────────────┐         │
│  ┌──────────────────┐             │ talos-worker-2   │         │
│  │ talos-cp-2       │             │ - General apps   │         │
│  │ - etcd           │             └──────────────────┘         │
│  │ - api-server     │             ┌──────────────────┐         │
│  │ - scheduler      │             │ talos-worker-3   │         │
│  └──────────────────┘             │ - General apps   │         │
│                                   └──────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

**Key Features**:
- Immutable OS with API-driven configuration
- No SSH access - all changes via API
- Minimal attack surface
- Cilium CNI with eBPF datapath
- GPU passthrough for hardware transcoding

**Provisioning**: Terragrunt module `terragrunt/modules/talos-cluster/`

### Layer 4: GitOps (ArgoCD)

**Purpose**: Continuous deployment and state reconciliation

```
┌─────────────────────────────────────────────────────────────────┐
│                          ArgoCD 2.11.x                           │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  App of Apps Pattern (gitops chart)                      │  │
│  │  ├── addons (Wave 1)                                     │  │
│  │  │   ├── MetalLB                                         │  │
│  │  │   ├── Traefik                                         │  │
│  │  │   ├── cert-manager                                    │  │
│  │  │   ├── external-dns                                    │  │
│  │  │   ├── 1password-operator                              │  │
│  │  │   ├── kube-prometheus-stack                           │  │
│  │  │   └── democratic-csi                                  │  │
│  │  └── applications (Wave 2)                               │  │
│  │      ├── Plex                                            │  │
│  │      ├── Sonarr/Radarr/Prowlarr                          │  │
│  │      ├── Home Assistant                                  │  │
│  │      └── Mosquitto                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Key Features**:
- Hierarchical application management
- Automatic sync with self-heal enabled
- Health status monitoring
- Sync waves for dependency ordering
- Web UI for visualization

**Bootstrap**: Terragrunt module `terragrunt/modules/gitops-bootstrap/`

---

## Technology Stack

### Infrastructure Layer

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| Hypervisor | Proxmox VE | 9.x | Bare-metal virtualization |
| Storage | TrueNAS Scale | 24.04.x | Network-attached storage |
| OS | Talos Linux | 1.7.x | Immutable Kubernetes OS |
| Kubernetes | K8s | 1.30.x | Container orchestration |
| IaC | Terraform | 1.7.x | Infrastructure provisioning |
| IaC Wrapper | Terragrunt | 0.55.x | DRY Terraform configs |
| Config Mgmt | Ansible | 2.16.x | Proxmox post-install |

### GitOps & Deployment

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| GitOps | ArgoCD | 2.11.x | Continuous deployment |
| Package Manager | Helm | 3.x | Kubernetes packages |
| Secrets | 1Password Operator | 1.x | External secrets injection |
| Updates | Renovate | Latest | Automated dependency updates |

### Networking

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| CNI | Cilium | 1.15.x | Container networking (eBPF) |
| Load Balancer | MetalLB | 0.14.x | Bare-metal load balancer (BGP) |
| Ingress | Traefik | 3.x | HTTP/HTTPS ingress |
| DNS | external-dns | 0.14.x | Automatic DNS records |
| Router | UniFi Dream Machine | Latest | Network gateway + BGP peer |

### Observability

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| Metrics | Prometheus | 2.x | Time-series metrics |
| Dashboards | Grafana | 10.x | Visualization |
| Alerts | Alertmanager | 0.27.x | Alert routing |
| Service Mesh | Cilium | 1.15.x | Network observability |

### Storage

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| CSI Driver | democratic-csi | Latest | Dynamic PV provisioning |
| Filesystem | ZFS | OpenZFS 2.x | Copy-on-write filesystem |
| Protocol | NFS | v4 | Network file sharing |

### Local Development

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| Local K8s | Kind | 0.22.x | Kubernetes in Docker |
| Dev Env | Tilt | 0.33.x | Hot reload for K8s |
| Storage | local-path-provisioner | 0.0.26 | Local PVs for Kind |

---

## GitOps Bridge Pattern

The GitOps Bridge pattern enables a smooth handoff from infrastructure provisioning (Terraform) to application management (ArgoCD).

### Bridge Flow

```
┌─────────────┐
│  Terraform  │
│  Provisions │
│  Cluster    │
└──────┬──────┘
       │
       │ 1. Creates K8s cluster
       │ 2. Installs ArgoCD
       │ 3. Creates ConfigMap with metadata
       │
       ▼
┌─────────────────────────────────┐
│  GitOps Bridge ConfigMap        │
│                                 │
│  metadata:                      │
│    cluster_name: homelab        │
│    environment: homelab         │
│    addons_repo: github.com/...  │
│    apps_repo: github.com/...    │
└──────┬──────────────────────────┘
       │
       │ 4. ArgoCD reads ConfigMap
       │ 5. Creates Applications based on metadata
       │
       ▼
┌─────────────┐
│   ArgoCD    │
│   Takes     │
│   Control   │
└──────┬──────┘
       │
       │ 6. Syncs applications
       │ 7. Monitors drift
       │ 8. Auto-heals
       │
       ▼
┌─────────────┐
│ Applications│
│  Running    │
└─────────────┘
```

### Implementation

**Terraform Side** (`terragrunt/modules/gitops-bootstrap/`):
```hcl
resource "kubernetes_namespace" "argocd" {
  metadata {
    name = "argocd"
  }
}

resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  namespace  = kubernetes_namespace.argocd.metadata[0].name
  version    = "5.51.6"
}

resource "kubernetes_config_map" "gitops_bridge" {
  metadata {
    name      = "gitops-bridge-metadata"
    namespace = "argocd"
  }

  data = {
    cluster_name   = var.cluster_name
    environment    = var.environment
    addons_repo    = var.gitops_repo_url
    apps_repo      = var.gitops_repo_url
    target_revision = var.gitops_target_revision
  }
}

resource "kubectl_manifest" "gitops_app" {
  yaml_body = templatefile("${path.module}/templates/gitops-application.yaml", {
    repo_url        = var.gitops_repo_url
    target_revision = var.gitops_target_revision
    environment     = var.environment
  })
}
```

**ArgoCD Side** (`charts/gitops/`):
```yaml
# charts/gitops/templates/addons.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: addons
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  project: default
  source:
    repoURL: '{{ .Values.repoURL }}'
    targetRevision: '{{ .Values.targetRevision }}'
    path: charts/addons
    helm:
      valueFiles:
        - values.yaml
        - values-{{ .Values.environment }}.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

### Benefits

1. **Clear Separation**: Terraform manages infrastructure, ArgoCD manages applications
2. **No Drift**: ArgoCD prevents manual kubectl changes from persisting
3. **Scalability**: Easy to add new applications without touching Terraform
4. **Rollback**: Git revert = infrastructure rollback
5. **Audit Trail**: Every change tracked in Git

---

## Network Architecture

See [networking.md](./networking.md) for complete details.

### Network Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                    UniFi Dream Machine                           │
│                    172.16.100.1                                  │
│                    BGP ASN: 64513                                │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  │ VLAN 100 (Homelab)
                  │ 172.16.100.0/24
                  │
    ┌─────────────┼─────────────┬─────────────┬─────────────┐
    │             │             │             │             │
┌───▼────┐  ┌────▼────┐  ┌─────▼────┐  ┌────▼────┐  ┌────▼────┐
│Proxmox │  │TrueNAS  │  │ Talos    │  │ Talos   │  │ Talos   │
│.250    │  │ (DHCP)  │  │ CP-1     │  │ CP-2    │  │Worker-1 │
└────────┘  └─────────┘  └──────────┘  └─────────┘  └─────────┘
                                │
                                │ BGP Peering
                                │
                         ┌──────▼──────┐
                         │   MetalLB   │
                         │ 64512       │
                         │ 100-200 IPs │
                         └─────────────┘
```

### IP Allocation

| Device/Service | IP Address | Notes |
|----------------|------------|-------|
| UniFi Controller | 172.16.100.1 | Gateway + BGP peer |
| IPMI | 172.16.100.26 | Out-of-band management |
| Proxmox | 172.16.100.250 | Hypervisor management |
| TrueNAS | DHCP | Storage VM |
| Talos Control Plane 1 | DHCP | K8s master |
| Talos Control Plane 2 | DHCP | K8s master |
| Talos Worker 1-3 | DHCP | K8s workers |
| MetalLB Pool | 172.16.100.100-200 | Service load balancer IPs |

### BGP Configuration

- **Kubernetes ASN**: 64512 (MetalLB)
- **Router ASN**: 64513 (UniFi)
- **Advertisement**: MetalLB advertises service IPs to UniFi router
- **Routing**: UniFi automatically routes traffic to correct K8s node

---

## Storage Architecture

### ZFS Pool Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                      TrueNAS ZFS Pool                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Data vDev (RAIDZ3)                                       │  │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ │  │
│  │  │20TB│ │20TB│ │20TB│ │20TB│ │20TB│ │20TB│ │20TB│ │20TB│ │  │
│  │  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ │  │
│  │  Usable: ~120TB (2-disk fault tolerance)                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Special vDev (Metadata + Small Blocks)                  │  │
│  │  ┌────────┐ ┌────────┐                                   │  │
│  │  │ 1TB    │ │ 1TB    │                                   │  │
│  │  │ NVMe   │ │ NVMe   │  RAID-1 Mirror                    │  │
│  │  └────────┘ └────────┘                                   │  │
│  │  Stores: Metadata, blocks < 128KB                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Storage Provisioning

**Democratic CSI** provides dynamic storage provisioning:

```
Kubernetes PVC Request
         │
         ▼
Democratic CSI Controller
         │
         ├─── Creates NFS dataset on TrueNAS
         ├─── Sets permissions and quotas
         └─── Returns PV to Kubernetes
         │
         ▼
Pod mounts NFS volume
```

### Storage Classes

```yaml
# Fast storage (Special vDev)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: truenas-nfs-fast
provisioner: org.democratic-csi.nfs
parameters:
  recordSize: "128k"
  compression: "lz4"
  dedup: "off"

# Standard storage (HDD Pool)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: truenas-nfs
provisioner: org.democratic-csi.nfs
parameters:
  recordSize: "1M"
  compression: "lz4"
  dedup: "off"
```

---

## Compute Architecture

### Resource Allocation

| VM | vCPUs | RAM | Storage | Purpose |
|----|-------|-----|---------|---------|
| TrueNAS | 4 | 32 GB | 100 GB | Storage controller |
| Talos CP-1 | 2 | 4 GB | 50 GB | Kubernetes master |
| Talos CP-2 | 2 | 4 GB | 50 GB | Kubernetes master |
| Talos Worker-1 | 6 | 64 GB | 100 GB | GPU workloads (Plex) |
| Talos Worker-2 | 4 | 32 GB | 100 GB | General workloads |
| Talos Worker-3 | 4 | 32 GB | 100 GB | General workloads |
| **Total** | **22/24** | **168/256 GB** | **550 GB** | |

### GPU Passthrough

NVIDIA Quadro P2200 passed through to Talos Worker-1:

```yaml
# talos/patches/gpu-passthrough.yaml
machine:
  kernel:
    modules:
      - name: nvidia
      - name: nvidia_uvm
      - name: nvidia_drm
      - name: nvidia_modeset
  install:
    extensions:
      - siderolabs/nonfree-kmod-nvidia
      - siderolabs/nvidia-container-toolkit
```

**Usage**: Plex uses GPU for hardware-accelerated transcoding

---

## Application Deployment

### Deployment Flow

```
Git Push
   │
   ▼
GitHub Actions (CI)
   │
   ├─── Lint YAML
   ├─── Validate Helm charts
   ├─── Run Tilt CI tests
   └─── Merge to main
   │
   ▼
ArgoCD (CD)
   │
   ├─── Detects change
   ├─── Syncs applications
   ├─── Health check
   └─── Running
```

### Application Structure

```
charts/
├── gitops/                    # App of Apps (umbrella)
│   ├── templates/
│   │   ├── addons.yaml        # Sync Wave 1
│   │   └── applications.yaml  # Sync Wave 2
│   └── values-{env}.yaml
├── addons/                    # Core infrastructure
│   └── templates/
│       ├── metallb.yaml
│       ├── traefik.yaml
│       └── ...
└── applications/              # User applications
    └── templates/
        ├── plex.yaml
        ├── sonarr.yaml
        └── ...
```

### Sync Waves

ArgoCD uses sync waves to control deployment order:

1. **Wave 0**: Namespaces, CRDs
2. **Wave 1**: Core addons (MetalLB, cert-manager, etc.)
3. **Wave 2**: Applications (Plex, Sonarr, etc.)

---

## Security Architecture

### Defense in Depth

1. **Network Layer**
   - VLAN isolation
   - Firewall rules on UniFi
   - No inbound WAN connections
   - VPN-only external access

2. **Platform Layer**
   - Immutable OS (Talos)
   - No SSH access
   - API-driven administration
   - Minimal attack surface

3. **Kubernetes Layer**
   - RBAC enabled
   - Network policies (Cilium)
   - Pod security standards
   - Resource quotas

4. **Application Layer**
   - Non-root containers
   - Read-only root filesystems
   - Secrets managed externally (1Password)
   - TLS everywhere (cert-manager)

### Secrets Management

```
1Password Vault
      │
      │ 1Password Connect API
      │
      ▼
1Password Operator (K8s)
      │
      │ Syncs secrets to K8s
      │
      ▼
Kubernetes Secrets
      │
      │ Mounted as volumes/env vars
      │
      ▼
Application Pods
```

**Benefits**:
- Secrets never stored in Git
- Centralized secret rotation
- Audit trail of secret access
- External secret store (not in etcd)

---

## Monitoring and Observability

### Metrics Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                    kube-prometheus-stack                         │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Prometheus  │  │   Grafana    │  │ Alertmanager │         │
│  │              │  │              │  │              │         │
│  │  Scrapes:    │  │  Dashboards: │  │  Alerts:     │         │
│  │  - K8s API   │  │  - Cluster   │  │  - Slack     │         │
│  │  - Nodes     │  │  - Nodes     │  │  - Email     │         │
│  │  - Pods      │  │  - Apps      │  │  - PagerDuty │         │
│  │  - Services  │  │  - Custom    │  │              │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

### Key Metrics

- **Cluster Health**: Node status, pod health, resource usage
- **Application Metrics**: Request rates, latencies, error rates
- **Infrastructure Metrics**: Disk usage, network traffic, temperature
- **Business Metrics**: Media library size, transcoding sessions

### Dashboards

- Kubernetes Cluster Overview
- Node Exporter Full
- Persistent Volumes
- ArgoCD Application Status
- Plex Transcoding Sessions
- Home Assistant

---

## Disaster Recovery

See [disaster-recovery.md](./disaster-recovery.md) for complete procedures.

### Backup Strategy

| Component | Backup Method | Frequency | Retention |
|-----------|---------------|-----------|-----------|
| Proxmox Config | Ansible playbooks in Git | On change | Forever (Git) |
| TrueNAS Config | ZFS snapshots | Hourly | 7 days |
| TrueNAS Data | ZFS replication | Daily | 30 days |
| K8s Configs | Git repository | On push | Forever (Git) |
| Application Data | PVC snapshots | Daily | 7 days |
| etcd | Talos built-in backup | Hourly | 7 days |

### Recovery Time Objectives

| Scenario | RTO | RPO | Impact |
|----------|-----|-----|--------|
| Pod failure | 30 seconds | 0 | Single app |
| Node failure | 5 minutes | 0 | Multiple apps |
| Cluster failure | 1 hour | 1 hour | All apps |
| Complete loss | 4 hours | 24 hours | Everything |

---

## Environment Strategy

### Environment Comparison

| Feature | localdev | homelab |
|---------|----------|---------|
| Platform | Kind (Docker) | Proxmox VMs |
| Nodes | 1 control-plane | 2 CP + 3 workers |
| Storage | local-path | TrueNAS NFS |
| Load Balancer | NodePort | MetalLB (BGP) |
| DNS | /etc/hosts | external-dns |
| Secrets | Fake secrets | 1Password |
| GPU | None | NVIDIA P2200 |
| Monitoring | Optional | Full stack |

### Workflow

1. **Develop Locally**: Make changes, test with Tilt (seconds to see changes)
2. **Push to Git**: CI validates charts and configs
3. **Deploy to Homelab**: ArgoCD syncs to homelab environment
4. **Verify**: Confirm changes work in homelab environment

---

## Troubleshooting

### Common Issues

#### ArgoCD Application OutOfSync

**Symptom**: Application shows as OutOfSync in ArgoCD UI

**Diagnosis**:
```bash
# Check application status
kubectl -n argocd get applications

# View detailed sync status
argocd app get <app-name>

# View diff
argocd app diff <app-name>
```

**Resolution**:
```bash
# Manual sync
argocd app sync <app-name>

# Hard refresh (ignore cache)
argocd app sync <app-name> --force
```

#### Persistent Volume Not Binding

**Symptom**: PVC stuck in Pending state

**Diagnosis**:
```bash
# Check PVC status
kubectl get pvc -A

# Check PV availability
kubectl get pv

# Check democratic-csi logs
kubectl -n democratic-csi logs -l app=democratic-csi-controller
```

**Resolution**:
- Verify TrueNAS is accessible from cluster
- Check NFS exports are configured
- Verify storage class exists
- Check CSI driver logs for errors

#### MetalLB Not Advertising IPs

**Symptom**: LoadBalancer services stuck in Pending

**Diagnosis**:
```bash
# Check MetalLB speaker pods
kubectl -n metallb-system get pods

# Check BGP peering
kubectl -n metallb-system logs -l component=speaker | grep BGP

# Check IP pool configuration
kubectl -n metallb-system get ipaddresspool
```

**Resolution**:
- Verify BGP peer configuration on UniFi
- Check ASN numbers match
- Verify IP pool range is correct
- Check router logs for BGP session

#### GPU Not Available in Pod

**Symptom**: Plex cannot access GPU for transcoding

**Diagnosis**:
```bash
# Check GPU is visible on node
kubectl get nodes -o jsonpath='{.items[*].status.capacity}'

# Exec into pod and check
kubectl -n media exec -it plex-xxx -- nvidia-smi
```

**Resolution**:
- Verify GPU passthrough in Proxmox
- Check Talos GPU patch is applied
- Verify nvidia-runtime is configured
- Check pod requests GPU in spec

### Useful Commands

```bash
# View all applications across all namespaces
kubectl get applications -A

# Force ArgoCD to refresh
argocd app get <app-name> --refresh

# View pod logs across all namespaces
kubectl logs -f -n <namespace> <pod-name>

# Get all events sorted by time
kubectl get events --all-namespaces --sort-by='.lastTimestamp'

# Check resource usage
kubectl top nodes
kubectl top pods -A

# View Talos service status
talosctl -n <node-ip> service status

# View Talos logs
talosctl -n <node-ip> logs kubelet
```

---

## References

### Official Documentation

- [Proxmox VE Documentation](https://pve.proxmox.com/pve-docs/)
- [TrueNAS Scale Documentation](https://www.truenas.com/docs/scale/)
- [Talos Linux Documentation](https://www.talos.dev/latest/)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [ArgoCD Documentation](https://argo-cd.readthedocs.io/)
- [Helm Documentation](https://helm.sh/docs/)

### Design Patterns

- [GitOps Bridge Pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- [App of Apps Pattern](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/)
- [Kustomize Best Practices](https://kubectl.docs.kubernetes.io/guides/config_management/)

### Community Resources

- [Awesome Homelab](https://github.com/awesome-foss/awesome-sysadmin)
- [r/homelab](https://reddit.com/r/homelab)
- [Talos on Proxmox with OpenTofu](https://blog.stonegarden.dev/articles/2024/08/talos-proxmox-tofu/)

### Related Documentation

- [networking.md](./networking.md) - Network topology and BGP configuration
- [disaster-recovery.md](./disaster-recovery.md) - Backup and recovery procedures
- [hardware-setup.md](./hardware-setup.md) - Physical hardware configuration
- [local-development.md](./local-development.md) - Local dev environment setup
- [runbooks/proxmox-recovery.md](./runbooks/proxmox-recovery.md) - Proxmox disaster recovery
- [runbooks/talos-upgrade.md](./runbooks/talos-upgrade.md) - Talos cluster upgrade procedures
- [runbooks/truenas-maintenance.md](./runbooks/truenas-maintenance.md) - TrueNAS maintenance

---

**Last Updated**: 2026-01-19
**Version**: 1.0
**Maintainer**: homelab team
