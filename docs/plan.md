# Homelab Project Plan

## Project Overview

Watering plants together. Teaching small hands to be gentle. Ordinary lessons on ordinary days. This homelab needs no watering, no tending, so I can tend to what actually grows—so the answer is always yes.

A GitOps-driven, family-first homelab monorepo using CNCF best practices. Single entrypoint setup, minimal ongoing maintenance, designed to build once, run forever.

## Task Tracking Strategy

This plan leverages `bd` (task tracking) for managing long-running implementation tasks with context preservation.

### Task Organization Principles

1. **Hierarchical Task Structure**: Tasks follow a phase.subphase.task naming convention (e.g., `0.1.2` for Phase 0, Subphase 1, Task 2)
2. **Context Preservation**: After each significant milestone, save progress and context to enable resumption
3. **Parallel Execution**: Tasks marked with `[PARALLEL]` can be executed simultaneously using sub-agents
4. **Progress Checkpoints**: Each phase has explicit checkpoints where state is saved
5. **Atomic Units**: Tasks are broken down to 2-4 hour units of work for manageable progress tracking

### Sub-Agent Opportunities

Tasks marked with these tags indicate sub-agent usage:
- `[EXPLORE]` - Use Explore agent for codebase/research tasks
- `[PARALLEL]` - Multiple tasks can run simultaneously
- `[BACKGROUND]` - Long-running tasks suitable for background execution
- `[VALIDATION]` - Testing/verification tasks

### Dependency Graph

```
Phase 0 (Repository Foundation)
  ├─→ Phase 0.5 (Local Dev Environment) [PARALLEL with Phase 1+]
  └─→ Phase 1 (Proxmox Installation)
       └─→ Phase 2 (Proxmox Configuration)
            └─→ Phase 3 (Infrastructure Provisioning)
                 ├─→ Phase 3.0-3.2 (Storage Layer)
                 ├─→ Phase 3.3-3.5 (Compute Layer) [Depends on 3.0-3.2]
                 └─→ Phase 3.6 (GitOps Bootstrap) [Depends on 3.3-3.5]
                      └─→ Phase 4 (Core Addons)
                           └─→ Phase 5 (UniFi SDN)
                                └─→ Phase 6 (User Applications)
                                     └─→ Phase 7 (Documentation) [PARALLEL with all phases]
```

### Progress Tracking

Each phase will:
1. Create a tracking task in `bd` with phase number and description
2. Update task status at each checkpoint
3. Save context including: configuration files created, decisions made, blockers encountered
4. Mark completion only when all acceptance criteria are met

---

## Objectives

- Build a homelab using Terragrunt (Terraform), Ansible Playbooks, TrueNAS Scale (NAS Storage VM), and Talos OS Kubernetes
- Minimize manual steps required by the user
- Minimize cost through efficient resource utilization
- Use off-the-shelf open source technologies with preference for CNCF-neutral projects
- Build a technology stack interchangeable with modern enterprise environments
- Build around GitOps using the [GitOps Bridge pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- Support automated patching and remediation via Renovate
- Leverage autonomous agentic architectures/workflows
- Support scale-out architecture (adding Proxmox cluster members in the future)
- Support auto-recovery and self-healing
- Configure backup and recovery policies and procedures
- Configure comprehensive monitoring and observability using kube-prometheus-stack
- Provide repeatable, dynamic orchestration for all homelab components
- Support multiple environments: localdev and homelab
- Enable rapid local development iteration using Kind and Tilt

## Architecture Overview

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
│                     Phase 1: Manual → Proxmox Installation                   │
│                   (Bare-metal hypervisor with post-install scripts)          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  Phase 2: Ansible → Proxmox Configuration                    │
│           (Post-install, StorCLI firmware, IPMI fans, networking)           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Phase 3: Terragrunt → Infrastructure                      │
│              ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│              │   TrueNAS    │    │ Talos Linux  │    │   ArgoCD     │      │
│              │  Scale VM    │    │   Cluster    │    │  Bootstrap   │      │
│              │ (HBA Pass-   │    │ (2 CP + 3    │    │  (GitOps     │      │
│              │  through)    │    │  Workers)    │    │   Bridge)    │      │
│              └──────────────┘    └──────────────┘    └──────────────┘      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Phase 4: GitOps Bridge → ArgoCD                          │
│         (Terragrunt passes metadata, ArgoCD takes over deployment)          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Phase 5: ArgoCD → Helm Charts                          │
│    ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│    │ charts/ │ │ charts/ │ │ charts/ │→│ Addons  │→│  Apps   │            │
│    │ gitops  │→│ addons  │→│  apps   │ │(Wave 1) │ │(Wave 2) │            │
│    └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Phase 6: SDN Integration                               │
│                    UniFi ←──BGP Peering──→ MetalLB                          │
│              (Dynamic route advertisement for service IPs)                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Hardware Specifications

### Host Resources (Proxmox)

| Resource | Specification |
|----------|---------------|
| RAM | 256 GB |
| vCPUs | 24 total |
| GPU | HP NVIDIA Quadro P2200 5GB GDDR5X (passthrough to K8s for Plex) |
| OS Drive | 250GB NVMe (Proxmox OS) |
| VM Storage | 2x 1TB NVMe (ZFS RAID-1 mirror for VMs/ISOs) |
| HBA Card 1 | Broadcom 9400-8i (dedicated to Proxmox, not passed through) |
| HBA Card 2 | Broadcom 9400-8i Mixed Mode (passed through to TrueNAS) |

### Storage Resources (TrueNAS VM - HBA Passthrough)

| Resource | Specification |
|----------|---------------|
| Data Drives | 8x 20TB HDDs (managed by TrueNAS, RAIDZ3 recommended) |
| Special vDev | 2x 1TB NVMe (ZFS RAID-1 mirror for metadata + small blocks) |
| HBA Card | Broadcom 9400-8i Mixed Mode (passed through for NVMe support) |

> **Note:** The special vdev stores metadata and small file blocks on fast NVMe storage, significantly improving random I/O performance while keeping bulk data on the HDD pool.

### Network Configuration

| Setting | Value |
|---------|-------|
| Base FQDN | ryanmcafee.com |
| Homelab VLAN | 100 |
| UniFi Controller | 172.16.100.1 |
| Proxmox Endpoint | 172.16.100.250 |
| IPMI Endpoint | 172.16.100.26 |
| IPMI Username | ADMIN |
| Kubernetes Subnet | 172.16.100.0/24 (VLAN 100) |
| MetalLB Pool | 172.16.100.100-172.16.100.200 |
| BGP ASN (K8s) | 64512 |
| BGP ASN (UniFi) | 64513 |

## Directory Structure

```
homelab/
├── .github/
│   ├── workflows/
│   │   ├── ansible-lint.yml
│   │   ├── terragrunt-plan.yml
│   │   ├── terragrunt-apply.yml
│   │   ├── yaml-lint.yml
│   │   ├── tilt-ci.yml                   # Validate Tiltfile in CI
│   │   └── renovate.yml
│   ├── renovate.json5
│   └── CODEOWNERS
│
├── ansible/
│   ├── inventory/
│   │   ├── hosts.yml
│   │   └── group_vars/
│   │       ├── all.yml
│   │       └── proxmox.yml
│   ├── playbooks/
│   │   ├── site.yml
│   │   ├── proxmox-post-install.yml
│   │   ├── proxmox-storcli.yml
│   │   ├── proxmox-ipmi-fans.yml
│   │   └── proxmox-networking.yml
│   ├── roles/
│   │   ├── proxmox-base/
│   │   ├── proxmox-storcli/
│   │   ├── proxmox-ipmi/
│   │   └── proxmox-networking/
│   ├── files/
│   │   └── storcli_007.0327.0000.0000_all.deb  # Checked in (Broadcom agreement)
│   ├── ansible.cfg
│   └── requirements.yml
│
├── terragrunt/
│   ├── terragrunt.hcl                    # Root configuration
│   ├── modules/
│   │   ├── proxmox-zfs-pool/             # ZFS mirror setup
│   │   ├── proxmox-backup-policy/        # Backup scheduling
│   │   ├── proxmox-vm/                   # Generic VM provisioning
│   │   ├── truenas/                      # TrueNAS VM with HBA passthrough
│   │   ├── talos-image/                  # Talos Image Factory schematics
│   │   ├── talos-cluster/                # Talos cluster provisioning
│   │   ├── kind-cluster/                 # Kind cluster for local dev
│   │   └── gitops-bootstrap/             # ArgoCD + GitOps Bridge
│   ├── environments/
│   │   ├── _env/
│   │   │   └── env.hcl                   # Shared environment config
│   │   ├── localdev/                     # Local development (Kind)
│   │   │   ├── env.hcl
│   │   │   ├── kind-cluster/
│   │   │   │   └── terragrunt.hcl
│   │   │   └── gitops-bootstrap/
│   │   │       └── terragrunt.hcl
│   │   ├── dev/
│   │   │   ├── env.hcl
│   │   │   ├── proxmox-zfs-pool/
│   │   │   │   └── terragrunt.hcl
│   │   │   ├── proxmox-backup-policy/
│   │   │   │   └── terragrunt.hcl
│   │   │   ├── truenas/
│   │   │   │   └── terragrunt.hcl
│   │   │   ├── talos-cluster/
│   │   │   │   └── terragrunt.hcl
│   │   │   └── gitops-bootstrap/
│   │   │       └── terragrunt.hcl
│   │   └── prod/
│   │       ├── env.hcl
│   │       ├── proxmox-zfs-pool/
│   │       │   └── terragrunt.hcl
│   │       ├── proxmox-backup-policy/
│   │       │   └── terragrunt.hcl
│   │       ├── truenas/
│   │       │   └── terragrunt.hcl
│   │       ├── talos-cluster/
│   │       │   └── terragrunt.hcl
│   │       └── gitops-bootstrap/
│   │           └── terragrunt.hcl
│   └── .terraform-version
│
├── localdev/                             # Local development environment
│   ├── kind-config.yaml                  # Kind cluster configuration
│   ├── Tiltfile                          # Tilt configuration for hot reload
│   ├── tilt_modules/                     # Reusable Tilt extensions
│   │   ├── argocd/
│   │   │   └── Tiltfile
│   │   ├── helm_remote/
│   │   │   └── Tiltfile
│   │   └── local_storage/
│   │       └── Tiltfile
│   ├── scripts/
│   │   ├── setup.sh                      # Setup local dev environment
│   │   ├── teardown.sh                   # Cleanup local dev environment
│   │   └── seed-secrets.sh               # Create local secrets
│   └── values/                           # Local override values
│       ├── argocd-values.yaml
│       ├── addons-values.yaml
│       └── applications-values.yaml
│
├── talos/
│   ├── image/
│   │   └── schematic.yaml                # Talos Image Factory customization
│   ├── machine-config/
│   │   ├── controlplane.yaml.tpl
│   │   └── worker.yaml.tpl
│   ├── patches/
│   │   ├── gpu-passthrough.yaml          # NVIDIA Quadro P2200 for workers
│   │   └── csi-nfs.yaml
│   └── inline-manifests/
│       └── cilium-install.yaml
│
├── charts/
│   ├── gitops/                           # Umbrella chart (App of Apps)
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   ├── values-localdev.yaml          # Local dev overrides
│   │   ├── values-homelab.yaml           # Homelab environment
│   │   └── templates/
│   │       ├── addons.yaml               # ArgoCD Application (sync-wave: 1)
│   │       └── applications.yaml         # ArgoCD Application (sync-wave: 2)
│   │
│   ├── addons/                           # Core cluster addons
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   ├── values-localdev.yaml          # Local: no MetalLB, no external-dns
│   │   ├── values-homelab.yaml
│   │   └── templates/
│   │       ├── metallb.yaml
│   │       ├── cert-manager.yaml
│   │       ├── external-dns.yaml
│   │       ├── 1password-operator.yaml
│   │       ├── kube-prometheus-stack.yaml
│   │       ├── democratic-csi.yaml
│   │       ├── local-path-provisioner.yaml  # For localdev only
│   │       └── traefik.yaml
│   │
│   └── applications/                     # User applications
│       ├── Chart.yaml
│       ├── values.yaml
│       ├── values-localdev.yaml          # Local: reduced resources, no GPU
│       ├── values-homelab.yaml
│       └── templates/
│           ├── plex.yaml                 # GPU-enabled (prod only)
│           ├── sonarr.yaml
│           ├── radarr.yaml
│           ├── prowlarr.yaml
│           ├── homeassistant.yaml
│           └── mosquitto.yaml
│
├── docs/
│   ├── architecture.md
│   ├── networking.md
│   ├── disaster-recovery.md
│   ├── hardware-setup.md
│   ├── local-development.md              # Local dev setup guide
│   └── runbooks/
│       ├── proxmox-recovery.md
│       ├── talos-upgrade.md
│       └── truenas-maintenance.md
│
├── scripts/
│   ├── setup.sh                          # Single entrypoint (prod)
│   ├── create-bootable-usb.sh
│   └── validate-prerequisites.sh
│
├── .envrc.example
├── .gitignore
├── Tiltfile                              # Root Tiltfile (includes localdev/)
├── Taskfile.yml
└── README.md
```

## Implementation Phases

### Phase 0: Repository Foundation

**Objective:** Set up repository structure, CI/CD, secrets management, and automation tooling.

**Task ID:** `phase-0-foundation`

#### Subphase 0.1: Directory Structure [PARALLEL]
**Task ID:** `0.1-directory-structure`

**Tasks:**
1. Create base directory structure from plan
2. Initialize .gitignore with appropriate entries
3. Create placeholder README.md

**Checkpoint:** Directory structure created, committed to git

**Files to create:**
- All directories from structure section
- `.gitignore`
- `README.md` (placeholder)

#### Subphase 0.2: GitHub Actions Setup [PARALLEL]
**Task ID:** `0.2-github-actions`

**Tasks:**
1. Create ansible-lint workflow
2. Create terragrunt-plan workflow
3. Create terragrunt-apply workflow
4. Create yaml-lint workflow
5. Create security scanning workflow (trivy, checkov)
6. Create CODEOWNERS file

**Checkpoint:** All workflows validate and pass

**Files to create:**
- `.github/workflows/ansible-lint.yml`
- `.github/workflows/terragrunt-plan.yml`
- `.github/workflows/terragrunt-apply.yml`
- `.github/workflows/yaml-lint.yml`
- `.github/workflows/security-scan.yml`
- `.github/CODEOWNERS`

#### Subphase 0.3: 1Password Integration [REQUIRES: Manual 1Password Setup]
**Task ID:** `0.3-1password`

**Tasks:**
1. Document 1Password Connect Server setup steps
2. Create .envrc.example with required 1Password variables
3. Document secret references in docs/

**Checkpoint:** 1Password integration documented

**Files to create:**
- `.envrc.example`
- `docs/secrets-management.md`

#### Subphase 0.4: Renovate Configuration [PARALLEL]
**Task ID:** `0.4-renovate`

**Tasks:**
1. Create renovate.json5 with Helm chart tracking
2. Add container image update rules
3. Add Terraform provider update rules
4. Add Ansible collection update rules
5. Configure auto-merge for patch versions
6. Test renovate config validation

**Checkpoint:** Renovate config validates successfully

**Files to create:**
- `.github/renovate.json5`

#### Subphase 0.5: Automation Tooling [PARALLEL]
**Task ID:** `0.5-automation`

**Tasks:**
1. Create Taskfile.yml with common tasks
2. Create scripts/setup.sh entrypoint
3. Create scripts/validate-prerequisites.sh
4. Make scripts executable

**Checkpoint:** Taskfile and scripts created, tested

**Files to create:**
- `Taskfile.yml`
- `scripts/setup.sh`
- `scripts/validate-prerequisites.sh`

**Acceptance criteria:**
- [ ] All linting passes on empty structure
- [ ] 1Password Connect documented
- [ ] Renovate config validates
- [ ] setup.sh runs without errors (even if no-op)
- [ ] Taskfile tasks execute successfully

---

### Phase 0.5: Local Development Environment (Kind + Tilt)

**Objective:** Enable rapid local testing of GitOps configurations without requiring physical infrastructure.

**Task ID:** `phase-0.5-localdev`

**[PARALLEL with Phase 1+]** - This can be developed independently while infrastructure work progresses

**Why Local Dev First?**
- Iterate on Helm charts and ArgoCD applications in seconds, not minutes
- Test changes before committing to real infrastructure
- Develop without physical access to homelab hardware
- CI validation of chart changes via Tilt in GitHub Actions

#### Subphase 0.5.1: Kind Cluster Configuration
**Task ID:** `0.5.1-kind-config`

**Tasks:**
1. Create localdev/kind-config.yaml
2. Configure control-plane with ingress-ready label
3. Add worker nodes with appropriate labels
4. Configure port mappings (Traefik, ArgoCD)
5. Test Kind cluster creation

**Checkpoint:** Kind cluster successfully creates and accepts workloads

#### Subphase 0.5.2: Tiltfile Development [PARALLEL]
**Task ID:** `0.5.2-tiltfile`

**Tasks:**
1. Create localdev/Tiltfile with mode selection (direct/argocd)
2. Add local-path-provisioner setup
3. Configure ArgoCD installation for argocd mode
4. Create helm_resource definitions for direct mode
5. Add development helper resources

**Checkpoint:** Tiltfile executes without errors in both modes

#### Subphase 0.5.3: Local Values Overrides [PARALLEL]
**Task ID:** `0.5.3-local-values`

**Tasks:**
1. Create charts/addons/values-localdev.yaml
2. Create charts/applications/values-localdev.yaml
3. Create localdev/values/argocd-values.yaml
4. Disable production-only components (metallb, external-dns)
5. Configure reduced resource requests

**Checkpoint:** All value files valid YAML, charts render successfully

#### Subphase 0.5.4: Taskfile Integration [PARALLEL]
**Task ID:** `0.5.4-taskfile-tasks`

**Tasks:**
1. Add localdev:up task
2. Add localdev:down task
3. Add localdev:reset task
4. Add localdev:logs task
5. Add chart development tasks (lint, template, diff)

**Checkpoint:** All Taskfile commands execute successfully

#### Subphase 0.5.5: CI Validation [VALIDATION]
**Task ID:** `0.5.5-tilt-ci`

**Tasks:**
1. Create .github/workflows/tilt-ci.yml
2. Configure Kind cluster creation in CI
3. Add Tilt installation step
4. Run Tilt CI with timeout
5. Test workflow on pull request

**Checkpoint:** CI workflow passes successfully

#### Local Dev Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Developer Workstation                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────────┐        ┌──────────────────────────────────────────┐ │
│   │   Tilt (HUD)     │        │           Kind Cluster                   │ │
│   │                  │        │  ┌─────────────────────────────────────┐ │ │
│   │  • Watch charts/ │───────▶│  │  ArgoCD                             │ │ │
│   │  • Auto-sync     │        │  │  ├── gitops app                     │ │ │
│   │  • Port forward  │        │  │  ├── addons app (localdev mode)     │ │ │
│   │  • Live logs     │        │  │  └── applications app               │ │ │
│   │                  │        │  └─────────────────────────────────────┘ │ │
│   └──────────────────┘        │  ┌─────────────────────────────────────┐ │ │
│                               │  │  Addons (localdev)                  │ │ │
│   ┌──────────────────┐        │  │  • local-path-provisioner (storage) │ │ │
│   │  Local Secrets   │───────▶│  │  • traefik (NodePort mode)          │ │ │
│   │  (.env.local)    │        │  │  • cert-manager (self-signed)       │ │ │
│   └──────────────────┘        │  │  • NO: metallb, external-dns, 1pw   │ │ │
│                               │  └─────────────────────────────────────┘ │ │
│                               │  ┌─────────────────────────────────────┐ │ │
│                               │  │  Applications (localdev)            │ │ │
│                               │  │  • Reduced resource requests        │ │ │
│                               │  │  • Local storage class              │ │ │
│                               │  │  • No GPU requirements              │ │ │
│                               │  └─────────────────────────────────────┘ │ │
│                               └──────────────────────────────────────────┘ │
│                                        │                                    │
│                                        ▼                                    │
│                               localhost:8080 (ArgoCD)                       │
│                               localhost:9080 (Traefik)                      │
│                               localhost:3000 (Grafana)                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Kind Cluster Configuration

```yaml
# localdev/kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: homelab-localdev
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      # Traefik HTTP/HTTPS
      - containerPort: 80
        hostPort: 9080
        protocol: TCP
      - containerPort: 443
        hostPort: 9443
        protocol: TCP
      # ArgoCD UI
      - containerPort: 30080
        hostPort: 8080
        protocol: TCP
  - role: worker
    labels:
      workload: applications
  - role: worker
    labels:
      workload: applications
networking:
  # Use Calico-compatible settings
  disableDefaultCNI: false
  podSubnet: "10.244.0.0/16"
  serviceSubnet: "10.96.0.0/12"
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:5000"]
      endpoint = ["http://kind-registry:5000"]
```

#### Tiltfile Configuration

```python
# localdev/Tiltfile
# Homelab Local Development Environment

# Configuration
config.define_string("mode", args=True)
cfg = config.parse()
mode = cfg.get("mode", "direct")  # "direct" or "argocd"

# ============================================================================
# Mode Selection
# ============================================================================
# direct:  Deploy Helm charts directly via Tilt (fastest iteration)
# argocd:  Deploy via ArgoCD (realistic GitOps simulation)

print("=" * 60)
print("Homelab Local Development")
print("Mode: %s" % mode)
print("=" * 60)

# ============================================================================
# Prerequisites
# ============================================================================

# Local path provisioner for storage
local_resource(
    "local-path-provisioner",
    cmd="kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml",
    deps=[],
    labels=["infrastructure"],
)

# Set default storage class
local_resource(
    "default-storage-class",
    cmd="""
    kubectl patch storageclass local-path -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
    """,
    resource_deps=["local-path-provisioner"],
    labels=["infrastructure"],
)

# ============================================================================
# ArgoCD Installation
# ============================================================================

if mode == "argocd":
    # Install ArgoCD
    local_resource(
        "argocd-install",
        cmd="""
        helm repo add argo https://argoproj.github.io/argo-helm
        helm repo update
        helm upgrade --install argocd argo/argo-cd \
            --namespace argocd --create-namespace \
            --values localdev/values/argocd-values.yaml \
            --wait
        """,
        resource_deps=["local-path-provisioner"],
        labels=["argocd"],
    )

    # Port forward ArgoCD UI
    k8s_resource(
        workload="argocd-server",
        port_forwards=["8080:443"],
        labels=["argocd"],
        resource_deps=["argocd-install"],
    )

    # Deploy gitops app pointing to charts/gitops
    local_resource(
        "gitops-app",
        cmd="""
        kubectl apply -f - <<EOF
        apiVersion: argoproj.io/v1alpha1
        kind: Application
        metadata:
          name: gitops
          namespace: argocd
        spec:
          project: default
          source:
            repoURL: https://github.com/YOUR_USERNAME/homelab.git
            targetRevision: HEAD
            path: charts/gitops
            helm:
              valueFiles:
                - values.yaml
                - values-localdev.yaml
          destination:
            server: https://kubernetes.default.svc
            namespace: argocd
          syncPolicy:
            automated:
              prune: true
              selfHeal: true
        EOF
        """,
        resource_deps=["argocd-install"],
        labels=["argocd"],
    )

    # Watch for ArgoCD Application changes
    watch_file("charts/")

# ============================================================================
# Direct Mode: Deploy Helm Charts via Tilt
# ============================================================================

if mode == "direct":
    # Addons
    helm_resource(
        "traefik",
        "traefik",
        repo_name="traefik",
        repo_url="https://traefik.github.io/charts",
        namespace="traefik",
        flags=[
            "--create-namespace",
            "--values=localdev/values/addons-values.yaml",
            "--set=service.type=NodePort",
            "--set=ports.web.nodePort=30080",
            "--set=ports.websecure.nodePort=30443",
        ],
        resource_deps=["local-path-provisioner"],
        labels=["addons"],
    )

    helm_resource(
        "cert-manager",
        "cert-manager",
        repo_name="jetstack",
        repo_url="https://charts.jetstack.io",
        namespace="cert-manager",
        flags=[
            "--create-namespace",
            "--set=installCRDs=true",
        ],
        resource_deps=["local-path-provisioner"],
        labels=["addons"],
    )

    # Prometheus Stack (optional - heavy)
    helm_resource(
        "kube-prometheus-stack",
        "kube-prometheus-stack",
        repo_name="prometheus-community",
        repo_url="https://prometheus-community.github.io/helm-charts",
        namespace="monitoring",
        flags=[
            "--create-namespace",
            "--values=localdev/values/addons-values.yaml",
            "--set=prometheus.prometheusSpec.resources.requests.memory=256Mi",
            "--set=prometheus.prometheusSpec.resources.requests.cpu=100m",
        ],
        resource_deps=["local-path-provisioner"],
        labels=["addons"],
        auto_init=False,  # Don't start by default (resource heavy)
    )

    # Applications - watch for changes and auto-deploy
    helm_resource(
        "sonarr",
        "charts/applications",
        namespace="media",
        flags=[
            "--create-namespace",
            "--values=charts/applications/values.yaml",
            "--values=charts/applications/values-localdev.yaml",
            "--set=sonarr.enabled=true",
        ],
        deps=["charts/applications"],
        labels=["applications"],
    )

    # Watch chart directories for changes
    watch_file("charts/addons")
    watch_file("charts/applications")
    watch_file("localdev/values")

# ============================================================================
# Development Helpers
# ============================================================================

# Print helpful URLs
local_resource(
    "dev-info",
    cmd="""
    echo ""
    echo "======================================"
    echo "Local Development URLs:"
    echo "======================================"
    echo "ArgoCD:    http://localhost:8080"
    echo "Traefik:   http://localhost:9080"
    echo "Grafana:   http://localhost:3000"
    echo ""
    echo "ArgoCD Password:"
    echo "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
    echo "======================================"
    """,
    labels=["info"],
    auto_init=True,
    trigger_mode=TRIGGER_MODE_MANUAL,
)
```

#### Local Values Overrides

```yaml
# charts/addons/values-localdev.yaml
# Local development overrides - minimal resource footprint

global:
  environment: localdev
  storageClass: local-path

# Disable components not needed locally
metallb:
  enabled: false

external-dns:
  enabled: false

1password-operator:
  enabled: false

democratic-csi:
  enabled: false

# Enable local alternatives
local-path-provisioner:
  enabled: true

# Traefik in NodePort mode
traefik:
  enabled: true
  service:
    type: NodePort
  ports:
    web:
      nodePort: 30080
    websecure:
      nodePort: 30443

# Lightweight cert-manager with self-signed issuer
cert-manager:
  enabled: true
  resources:
    requests:
      cpu: 10m
      memory: 32Mi

# Minimal Prometheus for testing
kube-prometheus-stack:
  enabled: true
  prometheus:
    prometheusSpec:
      retention: 1d
      resources:
        requests:
          memory: 256Mi
          cpu: 100m
      storageSpec:
        volumeClaimTemplate:
          spec:
            storageClassName: local-path
            resources:
              requests:
                storage: 5Gi
  grafana:
    adminPassword: admin
    resources:
      requests:
        cpu: 50m
        memory: 128Mi
  alertmanager:
    enabled: false
```

```yaml
# charts/applications/values-localdev.yaml
# Local development - reduced resources, no GPU

global:
  environment: localdev
  storageClass: local-path

# Disable GPU-dependent features
plex:
  enabled: true
  resources:
    limits:
      nvidia.com/gpu: 0  # No GPU locally
    requests:
      cpu: 100m
      memory: 512Mi
  persistence:
    config:
      storageClass: local-path
      size: 1Gi

sonarr:
  enabled: true
  resources:
    requests:
      cpu: 50m
      memory: 256Mi
  persistence:
    config:
      storageClass: local-path
      size: 1Gi

radarr:
  enabled: true
  resources:
    requests:
      cpu: 50m
      memory: 256Mi
  persistence:
    config:
      storageClass: local-path
      size: 1Gi

prowlarr:
  enabled: true
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
  persistence:
    config:
      storageClass: local-path
      size: 512Mi

# Home automation - simplified
homeassistant:
  enabled: false  # Requires host network, skip locally

mosquitto:
  enabled: true
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
```

#### Taskfile Integration

```yaml
# Taskfile.yml (relevant tasks)
version: '3'

tasks:
  # ==========================================================================
  # Local Development
  # ==========================================================================

  localdev:up:
    desc: Start local development environment
    cmds:
      - task: localdev:kind
      - task: localdev:tilt

  localdev:kind:
    desc: Create Kind cluster for local development
    cmds:
      - |
        if ! kind get clusters | grep -q homelab-localdev; then
          kind create cluster --config localdev/kind-config.yaml
        else
          echo "Cluster already exists"
        fi
      - kubectl cluster-info --context kind-homelab-localdev

  localdev:tilt:
    desc: Start Tilt for hot-reload development
    dir: localdev
    cmds:
      - tilt up
    env:
      KUBECONFIG: "{{.HOME}}/.kube/config"

  localdev:tilt:argocd:
    desc: Start Tilt in ArgoCD mode (realistic GitOps)
    dir: localdev
    cmds:
      - tilt up -- --mode=argocd

  localdev:down:
    desc: Tear down local development environment
    cmds:
      - tilt down --file localdev/Tiltfile || true
      - kind delete cluster --name homelab-localdev

  localdev:reset:
    desc: Reset local environment (full teardown + recreate)
    cmds:
      - task: localdev:down
      - task: localdev:up

  localdev:logs:
    desc: Stream logs from all pods
    cmds:
      - stern --all-namespaces '.*'

  localdev:shell:
    desc: Open shell in a debug pod
    cmds:
      - kubectl run -it --rm debug --image=busybox --restart=Never -- sh

  # ==========================================================================
  # Chart Development
  # ==========================================================================

  chart:lint:
    desc: Lint all Helm charts
    cmds:
      - helm lint charts/gitops
      - helm lint charts/addons
      - helm lint charts/applications

  chart:template:
    desc: Template charts for debugging
    cmds:
      - helm template gitops charts/gitops -f charts/gitops/values-localdev.yaml

  chart:diff:
    desc: Show diff of what would change
    cmds:
      - helm diff upgrade gitops charts/gitops -f charts/gitops/values-localdev.yaml -n argocd
```

#### GitHub Actions CI Validation

```yaml
# .github/workflows/tilt-ci.yml
name: Tilt CI

on:
  pull_request:
    paths:
      - 'charts/**'
      - 'localdev/**'
      - 'Tiltfile'

jobs:
  tilt-ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create Kind cluster
        uses: helm/kind-action@v1
        with:
          config: localdev/kind-config.yaml
          cluster_name: homelab-ci

      - name: Install Tilt
        run: |
          curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash

      - name: Run Tilt CI
        run: |
          cd localdev
          tilt ci --timeout 10m

      - name: Validate ArgoCD Applications
        run: |
          # Install ArgoCD CLI
          curl -sSL -o argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
          chmod +x argocd

          # Validate application manifests
          ./argocd app create gitops \
            --file charts/gitops/values-localdev.yaml \
            --dry-run \
            --validate
```

**Files to create:**
- `localdev/kind-config.yaml`
- `localdev/Tiltfile`
- `localdev/scripts/setup.sh`
- `localdev/scripts/teardown.sh`
- `localdev/values/*.yaml`
- `charts/*/values-localdev.yaml`
- `.github/workflows/tilt-ci.yml`
- `Tiltfile` (root, includes localdev/)

**Acceptance criteria:**
- [ ] All subphases (0.5.1-0.5.5) completed with checkpoints saved
- [ ] `task localdev:up` creates Kind cluster and starts Tilt
- [ ] Chart changes auto-deploy within seconds
- [ ] ArgoCD UI accessible at localhost:8080
- [ ] Applications deploy with local storage class
- [ ] `task localdev:down` cleanly removes all resources
- [ ] CI validates chart changes in GitHub Actions

**Context to preserve:**
- Kind cluster configuration decisions
- Tiltfile mode selection rationale
- Resource limit tuning for local environment
- Any issues encountered with specific charts locally

---

### Phase 1: Physical Setup & Proxmox Installation (Manual)

**Objective:** Physically set up hardware and install Proxmox hypervisor.

**Prerequisites:**
- Server assembled and rack-mounted
- Monitor and USB keyboard attached
- Network cabling complete (IPMI and data plane)

**Manual Steps:**

#### Step 1.1: Create Bootable USB
```bash
# Download Proxmox ISO
wget https://enterprise.proxmox.com/iso/proxmox-ve_9.1-1.iso

# Create bootable USB with Rufus (Windows) or dd (Linux)
# rufus.ie for Windows
# dd if=proxmox-ve_9.1-1.iso of=/dev/sdX bs=4M status=progress
```

#### Step 1.2: Install Proxmox
1. Boot server from USB (enter BIOS boot menu during startup)
2. Select Proxmox installation option 2 (CLI installation)
3. Follow installation prompts:
   - Target disk: 250GB NVMe (Proxmox OS)
   - Country/Timezone
   - Admin password and email
   - Management interface: Assign to VLAN 100
   - IP: 172.16.100.250/24
   - Gateway: 172.16.100.1
   - DNS: 172.16.100.1

#### Step 1.3: Post-Installation Verification
```bash
# Remove USB drive and reboot
# Verify network connectivity from another machine
ping 172.16.100.250

# Access Proxmox UI
# https://172.16.100.250:8006
```

**Acceptance criteria:**
- [ ] Proxmox accessible via web UI at https://172.16.100.250:8006
- [ ] SSH access working
- [ ] Network connectivity verified

---

### Phase 2: Proxmox Configuration (Ansible)

**Objective:** Configure Proxmox hypervisor with required settings, firmware, and storage.

**Tasks:**

#### Step 2.1: Post-Installation Script
```yaml
# ansible/playbooks/proxmox-post-install.yml
# Executes community script and installs dependencies
- name: Run Proxmox post-install script
  hosts: proxmox
  tasks:
    - name: Download and execute post-install script
      ansible.builtin.shell: |
        wget -qO- https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/tools/pve/post-pve-install.sh | bash
      args:
        creates: /etc/apt/sources.list.d/pve-no-subscription.list

    - name: Install required packages
      ansible.builtin.apt:
        name:
          - rsync
          - htop
          - iotop
        state: present
```

#### Step 2.2: StorCLI Installation & Firmware Flash
```yaml
# ansible/roles/proxmox-storcli/tasks/main.yml
# Flash Broadcom 9400-8i firmware for mixed mode (NVMe support)
# Note: storcli .deb is checked into repo due to Broadcom license agreement

- name: Copy StorCLI package
  ansible.builtin.copy:
    src: storcli_007.0327.0000.0000_all.deb
    dest: /tmp/storcli.deb

- name: Install StorCLI
  ansible.builtin.apt:
    deb: /tmp/storcli.deb

- name: Flash HBA firmware for mixed mode
  ansible.builtin.shell: |
    /opt/MegaRAID/storcli/storcli64 /c0 download file=/tmp/firmware.rom
  when: storcli_firmware_update | default(false)
```

**Reference:** https://docs.broadcom.com/doc/12354774

**Required Cables for U.2 NVMe:**
- Option 1: MPN 05-50065-00 (0.5M) - SFF-8643 to SFF-8639
- Option 2: MPN 05-50064-00 (1.0M) - SFF-8643 to SFF-8639

#### Step 2.3: IPMI Fan Threshold Configuration
```yaml
# ansible/roles/proxmox-ipmi/tasks/main.yml
# Fix Noctua fan cyclical spin-up on Supermicro servers
# Reference: https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/

- name: Install ipmitool
  ansible.builtin.apt:
    name: ipmitool
    state: present

- name: Configure fan thresholds
  ansible.builtin.shell: |
    ipmitool sensor thresh FAN1 lower 200 300 400
    ipmitool sensor thresh FAN2 lower 200 300 400
    ipmitool sensor thresh FAN3 lower 200 300 400
    ipmitool sensor thresh FAN4 lower 200 300 400

- name: Create systemd service for fan threshold on boot
  ansible.builtin.template:
    src: ipmi-fan-threshold.service.j2
    dest: /etc/systemd/system/ipmi-fan-threshold.service
  notify: Enable ipmi-fan-threshold service
```

#### Step 2.4: ZFS Storage Pool (via Terragrunt)
```hcl
# terragrunt/modules/proxmox-zfs-pool/main.tf
# Create ZFS RAID-1 mirror for VM storage

resource "proxmox_virtual_environment_pool" "vm_storage" {
  pool_id = "vm-storage"
  comment = "ZFS RAID-1 mirror for VMs and ISOs"
}

# Note: ZFS pool creation typically done via Proxmox CLI
# This module manages the logical pool in Proxmox
```

**Manual ZFS Setup (if not automated):**
```bash
# On Proxmox host
zpool create -f vm-storage mirror /dev/nvme1n1 /dev/nvme2n1
pvesm add zfspool vm-storage -pool vm-storage
```

**Files to create:**
- `ansible/inventory/hosts.yml`
- `ansible/inventory/group_vars/*.yml`
- `ansible/roles/proxmox-*/**`
- `ansible/playbooks/*.yml`
- `ansible/files/storcli_*.deb`
- `.github/workflows/ansible-lint.yml`

**Acceptance criteria:**
- [ ] Proxmox post-install script executed
- [ ] StorCLI installed, HBA firmware flashed (if needed)
- [ ] IPMI fan thresholds configured (no cyclical spin-up)
- [ ] ZFS RAID-1 pool created for VMs
- [ ] Idempotent Ansible runs

---

### Phase 3: Infrastructure Provisioning (Terragrunt)

**Objective:** Deploy TrueNAS, Talos Linux cluster, and bootstrap ArgoCD using Terragrunt.

**Task ID:** `phase-3-infrastructure`

**Dependencies:** Phase 2 (Proxmox Configuration) must be complete

---

#### Phase 3.0: Proxmox Backup Policy

**Task ID:** `3.0-backup-policy`

**Objective:** Configure automated VM backup scheduling in Proxmox

```hcl
# terragrunt/modules/proxmox-backup-policy/main.tf

resource "proxmox_virtual_environment_backup_schedule" "daily" {
  schedule_id = "daily-backup"
  schedule    = "0 2 * * *"  # 2 AM daily
  storage     = "vm-storage"
  mode        = "snapshot"
  compress    = "zstd"

  selection {
    include_all = true
  }

  retention {
    keep_daily  = 7
    keep_weekly = 4
  }
}
```

**Tasks:**
1. Create terragrunt/modules/proxmox-backup-policy module
2. Configure backup schedule (2 AM daily)
3. Set retention policy (7 daily, 4 weekly)
4. Test backup execution

**Checkpoint:** Backup policy deployed, first backup successful

**Acceptance criteria:**
- [ ] Terraform module created and validates
- [ ] Backup schedule active in Proxmox
- [ ] Test backup completes successfully

---

#### Phase 3.1: TrueNAS Scale VM Provisioning

**Task ID:** `3.1-truenas-vm`

**Objective:** Provision TrueNAS VM with HBA passthrough for storage

```hcl
# terragrunt/modules/truenas/main.tf

resource "proxmox_virtual_environment_vm" "truenas" {
  name        = "truenas"
  description = "TrueNAS Scale - NAS Storage"
  node_name   = var.proxmox_node

  cpu {
    cores = 4
    type  = "host"
  }

  memory {
    dedicated = 32768  # 32GB for ZFS ARC
  }

  # Boot disk
  disk {
    datastore_id = "vm-storage"
    size         = 32
    interface    = "virtio0"
  }

  # HBA Passthrough - Broadcom 9400-8i with 8x20TB + 2x1TB NVMe
  hostpci {
    device  = "hostpci0"
    id      = var.hba_pci_id  # e.g., "0000:03:00.0"
    pcie    = true
    rombar  = true
  }

  network_device {
    bridge  = "vmbr0"
    vlan_id = 100
  }

  boot_order = ["virtio0"]

  lifecycle {
    ignore_changes = [disk]
  }
}
```

**Tasks:**
1. Create terragrunt/modules/truenas module
2. Configure HBA passthrough (Broadcom 9400-8i)
3. Set VM resources (4 cores, 32GB RAM)
4. Configure network (VLAN 100)
5. Deploy VM and verify boot

**Checkpoint:** TrueNAS VM running, accessible via web UI

**Acceptance criteria:**
- [ ] Terraform module created and validates
- [ ] HBA passthrough configured correctly
- [ ] TrueNAS VM boots successfully
- [ ] Web UI accessible
- [ ] All 8x20TB HDDs and 2x1TB NVMe visible

**Context to preserve:**
- HBA PCI ID used for passthrough
- Any BIOS/firmware configuration changes needed
- VM resource allocation decisions

---

#### Phase 3.2: TrueNAS Storage Configuration

**Task ID:** `3.2-truenas-storage`

**Objective:** Configure ZFS pools and NFS exports in TrueNAS

**[BACKGROUND]** - This task may take several hours for initial pool creation
```yaml
# ansible/playbooks/truenas-configure.yml
# Post-provision TrueNAS configuration

- name: Configure TrueNAS
  hosts: truenas
  tasks:
    - name: Create main storage pool
      community.general.truenas_pool:
        name: storage
        vdevs:
          - type: RAIDZ3
            disks: "{{ truenas_data_disks }}"  # 8x20TB
        special_vdevs:
          - type: mirror
            disks: "{{ truenas_nvme_disks }}"  # 2x1TB

    - name: Create Kubernetes NFS dataset
      community.general.truenas_dataset:
        name: storage/kubernetes
        compression: lz4
        atime: "off"
        share_type: nfs

    - name: Configure NFS export for Kubernetes
      community.general.truenas_nfs_share:
        path: /mnt/storage/kubernetes
        networks:
          - "172.16.100.0/24"
        maproot_user: root
        maproot_group: wheel
```

**Tasks:**
1. Create Ansible playbook for TrueNAS configuration
2. Create ZFS pool (storage) with RAIDZ3 and special vdev
3. Create Kubernetes NFS dataset
4. Configure NFS export for 172.16.100.0/24
5. Verify NFS mount from Proxmox host

**Checkpoint:** ZFS pool created, NFS exports accessible

**Acceptance criteria:**
- [ ] ZFS pool 'storage' created with RAIDZ3 (8x20TB)
- [ ] Special vdev configured (2x1TB NVMe mirror)
- [ ] NFS share created and accessible
- [ ] Can mount NFS share from Proxmox host

**Context to preserve:**
- ZFS pool layout decisions
- Dataset naming conventions
- NFS export permissions configured
- Performance considerations for special vdev

---

#### Phase 3.3: Talos Image Preparation

**Task ID:** `3.3-talos-image`

**Objective:** Create custom Talos image with required system extensions

**[EXPLORE]** - Research Talos Image Factory schematic options

**Reference Implementation:** https://blog.stonegarden.dev/articles/2024/08/talos-proxmox-tofu/

```yaml
# talos/image/schematic.yaml
# Talos Image Factory customization

customization:
  systemExtensions:
    officialExtensions:
      - siderolabs/qemu-guest-agent
      - siderolabs/intel-ucode
      - siderolabs/i915-ucode
      - siderolabs/nvidia-container-toolkit  # For GPU passthrough
      - siderolabs/nfs-utils                 # For NFS CSI
```

**Tasks:**
1. Create talos/image/schematic.yaml
2. Add required system extensions (qemu, intel-ucode, nvidia, nfs)
3. Generate schematic ID via Talos Image Factory API
4. Create Proxmox download task for custom image
5. Verify image downloads to Proxmox

**Checkpoint:** Custom Talos image available in Proxmox

**Acceptance criteria:**
- [ ] Schematic YAML created and valid
- [ ] Image Factory schematic ID generated
- [ ] Custom Talos image downloaded to Proxmox
- [ ] Image includes all required extensions

**Context to preserve:**
- Talos version used
- Schematic ID generated
- Extension versions included
- Any compatibility issues discovered

---

#### Phase 3.4: Talos Cluster Provisioning

**Task ID:** `3.4-talos-cluster`

**Objective:** Provision Talos VMs in Proxmox (2 control-plane + 3 workers)

**Dependencies:** Phase 3.3 (Talos Image) must be complete

```hcl
# terragrunt/modules/talos-cluster/main.tf

locals {
  nodes = {
    "cp-1" = {
      ip           = "172.16.100.11"
      machine_type = "controlplane"
      host_node    = var.proxmox_node
      cores        = 4
      memory       = 8192
    }
    "cp-2" = {
      ip           = "172.16.100.12"
      machine_type = "controlplane"
      host_node    = var.proxmox_node
      cores        = 4
      memory       = 8192
    }
    "worker-1" = {
      ip           = "172.16.100.21"
      machine_type = "worker"
      host_node    = var.proxmox_node
      cores        = 4
      memory       = 32768
      gpu          = true  # NVIDIA Quadro P2200 for Plex
    }
    "worker-2" = {
      ip           = "172.16.100.22"
      machine_type = "worker"
      host_node    = var.proxmox_node
      cores        = 4
      memory       = 32768
    }
    "worker-3" = {
      ip           = "172.16.100.23"
      machine_type = "worker"
      host_node    = var.proxmox_node
      cores        = 4
      memory       = 32768
    }
  }
}

resource "talos_machine_secrets" "this" {
  talos_version = var.talos_version
}

resource "proxmox_virtual_environment_vm" "talos" {
  for_each = local.nodes

  name        = each.key
  description = "Talos ${each.value.machine_type}"
  node_name   = each.value.host_node

  cpu {
    cores = each.value.cores
    type  = "host"
  }

  memory {
    dedicated = each.value.memory
  }

  disk {
    file_id      = proxmox_virtual_environment_download_file.talos_image.id
    datastore_id = "vm-storage"
    size         = 50
    interface    = "virtio0"
  }

  # GPU Passthrough for worker with Plex
  dynamic "hostpci" {
    for_each = each.value.gpu ? [1] : []
    content {
      device  = "hostpci0"
      id      = var.gpu_pci_id  # NVIDIA Quadro P2200
      pcie    = true
      rombar  = true
      xvga    = false
    }
  }

  network_device {
    bridge  = "vmbr0"
    vlan_id = 100
  }

  initialization {
    ip_config {
      ipv4 {
        address = "${each.value.ip}/24"
        gateway = "172.16.100.1"
      }
    }
  }
}

resource "talos_machine_configuration_apply" "this" {
  for_each = local.nodes

  client_configuration        = talos_machine_secrets.this.client_configuration
  machine_configuration_input = each.value.machine_type == "controlplane" ? data.talos_machine_configuration.controlplane.machine_configuration : data.talos_machine_configuration.worker.machine_configuration
  node                        = each.value.ip

  depends_on = [proxmox_virtual_environment_vm.talos]
}
```

**Tasks:**
1. Create terragrunt/modules/talos-cluster module
2. Define node configuration (2 CP + 3 workers)
3. Configure GPU passthrough for worker-1
4. Set up network configuration (VLAN 100, static IPs)
5. Deploy VMs via Terragrunt
6. Verify all VMs boot successfully

**Checkpoint:** All Talos VMs running, reachable via network

**Acceptance criteria:**
- [ ] Terraform module created and validates
- [ ] All 5 VMs created in Proxmox
- [ ] GPU passthrough configured on worker-1
- [ ] All VMs accessible via SSH/talosctl
- [ ] Network connectivity verified

**Context to preserve:**
- IP address assignments for all nodes
- GPU PCI ID used for passthrough
- VM resource allocations
- Any boot issues encountered

---

#### Phase 3.5: Talos Cluster Bootstrap

**Task ID:** `3.5-talos-bootstrap`

**Objective:** Bootstrap Talos cluster and configure Kubernetes

**Dependencies:** Phase 3.4 (Talos Cluster Provisioning) must be complete

**[BACKGROUND]** - Cluster bootstrap may take 10-15 minutes

```yaml
# talos/machine-config/controlplane.yaml.tpl

cluster:
  clusterName: ${cluster_name}
  controlPlane:
    endpoint: https://${cluster_endpoint}:6443
  network:
    cni:
      name: none  # Using Cilium
    podSubnets:
      - 10.244.0.0/16
    serviceSubnets:
      - 10.96.0.0/12
  proxy:
    disabled: true  # Cilium handles this
  allowSchedulingOnControlPlanes: false

machine:
  certSANs:
    - ${cluster_endpoint}
    - 172.16.100.11
    - 172.16.100.12
  kubelet:
    extraArgs:
      rotate-server-certificates: true
  network:
    hostname: ${hostname}
    interfaces:
      - interface: eth0
        addresses:
          - ${node_ip}/24
        routes:
          - network: 0.0.0.0/0
            gateway: 172.16.100.1
```

```yaml
# talos/patches/gpu-passthrough.yaml
# Applied to worker-1 for Plex transcoding

machine:
  kernel:
    modules:
      - name: nvidia
      - name: nvidia_uvm
      - name: nvidia_drm
  nodeLabels:
    nvidia.com/gpu: "true"
    feature.node.kubernetes.io/pci-10de.present: "true"
```

**Tasks:**
1. Create talos/machine-config templates (controlplane.yaml.tpl, worker.yaml.tpl)
2. Create talos/patches for GPU passthrough and NFS CSI
3. Generate Talos machine configurations
4. Apply configurations to all nodes
5. Bootstrap cluster with `talosctl bootstrap`
6. Retrieve kubeconfig and verify cluster access
7. Apply Cilium CNI inline manifests
8. Verify all nodes Ready

**Checkpoint:** Talos cluster bootstrapped, kubectl access working

**Acceptance criteria:**
- [ ] Machine configs created for all node types
- [ ] Configurations applied successfully to all nodes
- [ ] Cluster bootstrap completes without errors
- [ ] All nodes show as Ready
- [ ] Cilium CNI operational
- [ ] kubectl access working
- [ ] GPU visible on worker-1 (nvidia.com/gpu)

**Context to preserve:**
- Talos secrets/certificates generated
- Cluster endpoint IP/FQDN
- Cilium configuration decisions
- Any bootstrap issues encountered
- Kubeconfig location

---

#### Phase 3.6: ArgoCD Bootstrap (GitOps Bridge)

**Task ID:** `3.6-argocd-bootstrap`

**Objective:** Deploy ArgoCD and configure GitOps Bridge pattern

**Dependencies:** Phase 3.5 (Talos Bootstrap) must be complete

```hcl
# terragrunt/modules/gitops-bootstrap/main.tf
# Implements GitOps Bridge pattern

resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  namespace        = "argocd"
  create_namespace = true
  version          = var.argocd_version

  values = [
    templatefile("${path.module}/values.yaml.tpl", {
      repo_url = var.repo_url
    })
  ]
}

# GitOps Bridge: Pass metadata to ArgoCD
resource "kubernetes_secret" "gitops_metadata" {
  metadata {
    name      = "gitops-metadata"
    namespace = "argocd"
    labels = {
      "argocd.argoproj.io/secret-type" = "cluster"
    }
  }

  data = {
    cluster_name      = var.cluster_name
    environment       = var.environment
    truenas_ip        = var.truenas_ip
    metallb_ip_range  = var.metallb_ip_range
    cloudflare_zone   = var.cloudflare_zone
    base_fqdn         = var.base_fqdn
  }
}

# Bootstrap Application - points to charts/gitops
resource "kubectl_manifest" "gitops_app" {
  depends_on = [helm_release.argocd]

  yaml_body = <<-YAML
    apiVersion: argoproj.io/v1alpha1
    kind: Application
    metadata:
      name: gitops
      namespace: argocd
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: default
      source:
        repoURL: ${var.repo_url}
        targetRevision: HEAD
        path: charts/gitops
        helm:
          valueFiles:
            - values.yaml
            - values-${var.environment}.yaml
      destination:
        server: https://kubernetes.default.svc
        namespace: argocd
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
  YAML
}
```

**Tasks:**
1. Create terragrunt/modules/gitops-bootstrap module
2. Deploy ArgoCD via Helm
3. Create gitops-metadata Kubernetes secret
4. Deploy bootstrap Application pointing to charts/gitops
5. Wait for ArgoCD to sync
6. Verify ArgoCD UI accessible
7. Retrieve admin password

**Checkpoint:** ArgoCD deployed and syncing, GitOps active

**Acceptance criteria:**
- [ ] ArgoCD Helm release deployed successfully
- [ ] GitOps Bridge metadata secret created
- [ ] Bootstrap Application syncing
- [ ] ArgoCD UI accessible (https://argocd.ryanmcafee.com)
- [ ] Can log in to ArgoCD
- [ ] gitops Application appears in UI

**Context to preserve:**
- ArgoCD version deployed
- Repository URL configured
- GitOps Bridge metadata values
- Admin credentials location
- Any sync issues encountered

---

**Files to create:**
- `terragrunt/terragrunt.hcl`
- `terragrunt/modules/**`
- `terragrunt/environments/**`
- `talos/**`

**Phase 3 Overall Acceptance criteria:**
- [ ] All subphases (3.0-3.6) completed with checkpoints saved
- [ ] TrueNAS VM running with HBA passthrough
- [ ] ZFS pools created (storage with RAIDZ3 + special vdev)
- [ ] NFS shares exported for Kubernetes
- [ ] Talos cluster healthy (2 CP + 3 workers)
- [ ] kubectl access working
- [ ] ArgoCD UI accessible
- [ ] GitOps Bridge metadata available
- [ ] Terragrunt state stored securely

**Context to preserve for Phase 3:**
- All infrastructure resource IDs (VMs, networks, storage)
- IP addresses assigned
- PCI device IDs used for passthrough
- Talos cluster configuration
- ArgoCD bootstrap decisions
- Any issues that required workarounds

---

### Phase 4: Core Addons (ArgoCD Managed)

**Objective:** Deploy core cluster services via ArgoCD App of Apps pattern.

**Task ID:** `phase-4-addons`

**Dependencies:** Phase 3.6 (ArgoCD Bootstrap) must be complete

**[PARALLEL]** - Many addons can be developed simultaneously

#### Subphase 4.1: GitOps Chart Structure [PARALLEL]
**Task ID:** `4.1-gitops-charts`

**Tasks:**
1. Create charts/gitops umbrella chart
2. Create charts/addons for infrastructure components
3. Create charts/applications for user apps
4. Set up sync waves (addons=1, applications=2)
5. Create environment-specific values files
6. Test chart rendering locally

**Checkpoint:** Chart structure created, renders without errors

#### Subphase 4.2: Infrastructure Addons Deployment
**Task ID:** `4.2-infra-addons`

**Charts Structure:**

```yaml
# charts/gitops/Chart.yaml
apiVersion: v2
name: gitops
description: GitOps umbrella chart - App of Apps
version: 1.0.0
type: application
```

```yaml
# charts/gitops/templates/addons.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: addons
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ .Values.repoURL }}
    targetRevision: {{ .Values.targetRevision }}
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

```yaml
# charts/gitops/templates/applications.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: applications
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "2"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ .Values.repoURL }}
    targetRevision: {{ .Values.targetRevision }}
    path: charts/applications
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

**Addons (Sync Wave 1):**

```yaml
# charts/addons/templates/metallb.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: metallb
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  project: default
  source:
    repoURL: https://metallb.github.io/metallb
    chart: metallb
    targetRevision: 0.14.x
    helm:
      values: |
        speaker:
          frr:
            enabled: true
  destination:
    server: https://kubernetes.default.svc
    namespace: metallb-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
---
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: default-pool
  namespace: metallb-system
spec:
  addresses:
    - 172.16.100.100-172.16.100.200
---
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: unifi-gateway
  namespace: metallb-system
spec:
  myASN: 64512
  peerASN: 64513
  peerAddress: 172.16.100.1
```

```yaml
# charts/addons/templates/1password-operator.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: 1password-operator
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  project: default
  source:
    repoURL: https://1password.github.io/connect-helm-charts
    chart: connect
    targetRevision: 1.15.x
    helm:
      values: |
        connect:
          credentials_base64: {{ .Values.onepassword.credentials }}
        operator:
          create: true
          token:
            value: {{ .Values.onepassword.token }}
  destination:
    server: https://kubernetes.default.svc
    namespace: 1password
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/addons/templates/cert-manager.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec:
  project: default
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
    targetRevision: v1.14.x
    helm:
      values: |
        installCRDs: true
        prometheus:
          enabled: true
          servicemonitor:
            enabled: true
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/addons/templates/external-dns.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: external-dns
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "4"
spec:
  project: default
  source:
    repoURL: https://kubernetes-sigs.github.io/external-dns
    chart: external-dns
    targetRevision: 1.14.x
    helm:
      values: |
        provider: cloudflare
        env:
          - name: CF_API_TOKEN
            valueFrom:
              secretKeyRef:
                name: cloudflare-api-token
                key: api-token
        domainFilters:
          - ryanmcafee.com
        txtOwnerId: homelab
        policy: sync
        sources:
          - ingress
          - service
  destination:
    server: https://kubernetes.default.svc
    namespace: external-dns
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/addons/templates/kube-prometheus-stack.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: kube-prometheus-stack
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "5"
spec:
  project: default
  source:
    repoURL: https://prometheus-community.github.io/helm-charts
    chart: kube-prometheus-stack
    targetRevision: 57.x
    helm:
      values: |
        prometheus:
          prometheusSpec:
            retention: 30d
            storageSpec:
              volumeClaimTemplate:
                spec:
                  storageClassName: truenas-nfs
                  accessModes: ["ReadWriteOnce"]
                  resources:
                    requests:
                      storage: 100Gi
        grafana:
          adminPassword: "" # From 1Password
          ingress:
            enabled: true
            annotations:
              cert-manager.io/cluster-issuer: letsencrypt-prod
            hosts:
              - grafana.ryanmcafee.com
            tls:
              - secretName: grafana-tls
                hosts:
                  - grafana.ryanmcafee.com
        alertmanager:
          alertmanagerSpec:
            storage:
              volumeClaimTemplate:
                spec:
                  storageClassName: truenas-nfs
                  accessModes: ["ReadWriteOnce"]
                  resources:
                    requests:
                      storage: 10Gi
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

```yaml
# charts/addons/templates/democratic-csi.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: democratic-csi
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  project: default
  source:
    repoURL: https://democratic-csi.github.io/charts
    chart: democratic-csi
    targetRevision: 0.14.x
    helm:
      values: |
        csiDriver:
          name: org.democratic-csi.nfs
        storageClasses:
          - name: truenas-nfs
            defaultClass: true
            reclaimPolicy: Delete
            volumeBindingMode: Immediate
            allowVolumeExpansion: true
            parameters:
              fsType: nfs
        driver:
          config:
            driver: freenas-nfs
            instance_id: truenas
            httpConnection:
              protocol: https
              host: 172.16.100.x  # TrueNAS IP
              port: 443
              apiKey: ""  # From 1Password
            nfs:
              shareHost: 172.16.100.x
              shareAllow:
                - 172.16.100.0/24
  destination:
    server: https://kubernetes.default.svc
    namespace: democratic-csi
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/addons/templates/traefik.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "6"
spec:
  project: default
  source:
    repoURL: https://traefik.github.io/charts
    chart: traefik
    targetRevision: 26.x
    helm:
      values: |
        service:
          type: LoadBalancer
          annotations:
            metallb.universe.tf/loadBalancerIPs: 172.16.100.100
        ports:
          web:
            redirectTo:
              port: websecure
          websecure:
            tls:
              enabled: true
        ingressRoute:
          dashboard:
            enabled: true
            matchRule: Host(`traefik.ryanmcafee.com`)
            entryPoints:
              - websecure
        providers:
          kubernetesCRD:
            enabled: true
          kubernetesIngress:
            enabled: true
        metrics:
          prometheus:
            enabled: true
            serviceMonitor:
              enabled: true
  destination:
    server: https://kubernetes.default.svc
    namespace: traefik
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

**Files to create:**
- `charts/gitops/**`
- `charts/addons/**`

**Tasks:**
1. Deploy MetalLB with FRR (sync-wave: 1)
2. Deploy 1Password Operator (sync-wave: 2)
3. Deploy Democratic-CSI for NFS storage (sync-wave: 2)
4. Deploy Cert-Manager (sync-wave: 3)
5. Deploy External-DNS (sync-wave: 4)
6. Deploy kube-prometheus-stack (sync-wave: 5)
7. Deploy Traefik ingress controller (sync-wave: 6)
8. Verify all addons healthy

**Checkpoint:** All infrastructure addons deployed and operational

**Acceptance criteria:**
- [ ] All subphases (4.1-4.2) completed with checkpoints saved
- [ ] MetalLB assigning LoadBalancer IPs
- [ ] BGP routes visible in UniFi controller (see Phase 5)
- [ ] 1Password Operator syncing secrets
- [ ] Cert-Manager issuing certificates
- [ ] External-DNS creating DNS records
- [ ] Prometheus/Grafana collecting metrics
- [ ] Democratic-CSI provisioning NFS volumes
- [ ] Traefik routing ingress traffic
- [ ] All addons show as Synced in ArgoCD

**Context to preserve:**
- Sync wave decisions and ordering
- Resource sizing for cluster scale
- Storage class configurations
- Certificate issuer setup (staging vs prod)
- Any addon compatibility issues
- Performance metrics during rollout

---

### Phase 5: UniFi SDN Integration

**Objective:** Configure UniFi gateway for BGP peering with MetalLB.

**Task ID:** `phase-5-unifi-bgp`

**Dependencies:** Phase 4.2 (MetalLB deployed) must be complete

**[REQUIRES: Manual UniFi Configuration]**

**Tasks:**
1. Enable BGP on UniFi gateway (requires UniFi OS 3.x+)
2. Configure BGP peer settings for both control-plane nodes
3. Set router-id on UniFi gateway
4. Verify BGP session establishment
5. Create test LoadBalancer service
6. Verify route advertisement and reachability

**UniFi BGP Configuration:**
```json
{
  "protocols": {
    "bgp": {
      "64513": {
        "neighbor": {
          "172.16.100.11": {
            "remote-as": "64512",
            "description": "k8s-cp-1"
          },
          "172.16.100.12": {
            "remote-as": "64512",
            "description": "k8s-cp-2"
          }
        },
        "parameters": {
          "router-id": "172.16.100.1"
        }
      }
    }
  }
}
```

**Network Topology:**
```
┌─────────────────────────────────────────────────────────────┐
│                      UniFi Gateway                          │
│                    AS 64513 / 172.16.100.1                 │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                    BGP Peers                         │  │
│   │    cp-1 (64512)           cp-2 (64512)             │  │
│   │    172.16.100.11          172.16.100.12            │  │
│   └─────────────────────────────────────────────────────┘  │
│                                                             │
│   Advertised routes: 172.16.100.100-200/32 (LB VIPs)      │
└─────────────────────────────────────────────────────────────┘
```

**Checkpoint:** BGP peering established, routes advertised

**Acceptance criteria:**
- [ ] BGP enabled on UniFi gateway
- [ ] BGP sessions established with both control-plane nodes
- [ ] Service IPs reachable from all VLANs
- [ ] No NAT required for service access
- [ ] Failover tested (kill a node, routes update automatically)
- [ ] Routes visible in UniFi routing table

**Context to preserve:**
- BGP ASN numbers used (64512 for K8s, 64513 for UniFi)
- UniFi OS version and BGP capabilities
- Any BGP session establishment issues
- Failover behavior observations

---

### Phase 6: User Applications (ArgoCD Managed)

**Objective:** Deploy end-user applications using TrueCharts Helm charts.

**Task ID:** `phase-6-applications`

**Dependencies:** Phase 4 (Core Addons) must be complete

**[PARALLEL]** - Applications can be developed and deployed independently

**TrueCharts Repository:** https://github.com/truecharts/charts

#### Subphase 6.1: Media Applications [PARALLEL]
**Task ID:** `6.1-media-apps`

**Applications:**
- Plex (with GPU transcoding)
- Sonarr
- Radarr
- Prowlarr

#### Subphase 6.2: Home Automation [PARALLEL]
**Task ID:** `6.2-home-automation`

**Applications:**
- Home Assistant
- Mosquitto MQTT Broker

```yaml
# charts/applications/templates/plex.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: plex
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  project: default
  source:
    repoURL: https://charts.truecharts.org
    chart: plex
    targetRevision: 18.x
    helm:
      values: |
        image:
          repository: plexinc/pms-docker
          tag: latest
        service:
          main:
            type: LoadBalancer
            annotations:
              metallb.universe.tf/loadBalancerIPs: 172.16.100.101
        ingress:
          main:
            enabled: true
            annotations:
              cert-manager.io/cluster-issuer: letsencrypt-prod
            hosts:
              - host: plex.ryanmcafee.com
                paths:
                  - path: /
                    pathType: Prefix
            tls:
              - secretName: plex-tls
                hosts:
                  - plex.ryanmcafee.com
        persistence:
          config:
            enabled: true
            storageClass: truenas-nfs
            size: 50Gi
          media:
            enabled: true
            type: nfs
            server: 172.16.100.x
            path: /mnt/storage/media
        # GPU Passthrough for transcoding
        resources:
          limits:
            nvidia.com/gpu: 1
        nodeSelector:
          nvidia.com/gpu: "true"
  destination:
    server: https://kubernetes.default.svc
    namespace: media
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/applications/templates/sonarr.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: sonarr
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  project: default
  source:
    repoURL: https://charts.truecharts.org
    chart: sonarr
    targetRevision: 21.x
    helm:
      values: |
        ingress:
          main:
            enabled: true
            annotations:
              cert-manager.io/cluster-issuer: letsencrypt-prod
            hosts:
              - host: sonarr.ryanmcafee.com
                paths:
                  - path: /
                    pathType: Prefix
            tls:
              - secretName: sonarr-tls
                hosts:
                  - sonarr.ryanmcafee.com
        persistence:
          config:
            enabled: true
            storageClass: truenas-nfs
            size: 10Gi
          media:
            enabled: true
            type: nfs
            server: 172.16.100.x
            path: /mnt/storage/media
  destination:
    server: https://kubernetes.default.svc
    namespace: media
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/applications/templates/radarr.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: radarr
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  project: default
  source:
    repoURL: https://charts.truecharts.org
    chart: radarr
    targetRevision: 21.x
    helm:
      values: |
        ingress:
          main:
            enabled: true
            annotations:
              cert-manager.io/cluster-issuer: letsencrypt-prod
            hosts:
              - host: radarr.ryanmcafee.com
                paths:
                  - path: /
                    pathType: Prefix
            tls:
              - secretName: radarr-tls
                hosts:
                  - radarr.ryanmcafee.com
        persistence:
          config:
            enabled: true
            storageClass: truenas-nfs
            size: 10Gi
          media:
            enabled: true
            type: nfs
            server: 172.16.100.x
            path: /mnt/storage/media
  destination:
    server: https://kubernetes.default.svc
    namespace: media
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/applications/templates/prowlarr.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: prowlarr
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  project: default
  source:
    repoURL: https://charts.truecharts.org
    chart: prowlarr
    targetRevision: 18.x
    helm:
      values: |
        ingress:
          main:
            enabled: true
            annotations:
              cert-manager.io/cluster-issuer: letsencrypt-prod
            hosts:
              - host: prowlarr.ryanmcafee.com
                paths:
                  - path: /
                    pathType: Prefix
            tls:
              - secretName: prowlarr-tls
                hosts:
                  - prowlarr.ryanmcafee.com
        persistence:
          config:
            enabled: true
            storageClass: truenas-nfs
            size: 5Gi
  destination:
    server: https://kubernetes.default.svc
    namespace: media
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/applications/templates/homeassistant.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: home-assistant
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec:
  project: default
  source:
    repoURL: https://charts.truecharts.org
    chart: home-assistant
    targetRevision: 23.x
    helm:
      values: |
        service:
          main:
            type: LoadBalancer
            annotations:
              metallb.universe.tf/loadBalancerIPs: 172.16.100.102
        ingress:
          main:
            enabled: true
            annotations:
              cert-manager.io/cluster-issuer: letsencrypt-prod
            hosts:
              - host: home.ryanmcafee.com
                paths:
                  - path: /
                    pathType: Prefix
            tls:
              - secretName: home-assistant-tls
                hosts:
                  - home.ryanmcafee.com
        persistence:
          config:
            enabled: true
            storageClass: truenas-nfs
            size: 20Gi
        # Host network for device discovery
        hostNetwork: true
  destination:
    server: https://kubernetes.default.svc
    namespace: home
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# charts/applications/templates/mosquitto.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: mosquitto
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec:
  project: default
  source:
    repoURL: https://charts.truecharts.org
    chart: mosquitto
    targetRevision: 14.x
    helm:
      values: |
        service:
          main:
            type: LoadBalancer
            annotations:
              metallb.universe.tf/loadBalancerIPs: 172.16.100.103
            ports:
              main:
                port: 1883
        persistence:
          config:
            enabled: true
            storageClass: truenas-nfs
            size: 1Gi
  destination:
    server: https://kubernetes.default.svc
    namespace: home
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

**Files to create:**
- `charts/applications/**`

**Tasks:**
1. Create Plex ArgoCD Application with GPU nodeSelector
2. Create Sonarr, Radarr, Prowlarr Applications
3. Configure NFS mounts to TrueNAS media dataset
4. Create Home Assistant Application with hostNetwork
5. Create Mosquitto MQTT Application
6. Configure ingress for all web UIs
7. Test GPU transcoding in Plex
8. Verify all applications functional

**Checkpoint:** All user applications deployed and operational

**Acceptance criteria:**
- [ ] All subphases (6.1-6.2) completed with checkpoints saved
- [ ] Plex accessible with GPU transcoding working
- [ ] Sonarr, Radarr, Prowlarr accessible and communicating
- [ ] Home Assistant running with device discovery
- [ ] Mosquitto MQTT broker accessible on LoadBalancer IP
- [ ] All apps using TrueNAS NFS storage
- [ ] All apps accessible via ingress with TLS certificates
- [ ] DNS records created automatically by external-dns

**Context to preserve:**
- GPU scheduling decisions for Plex
- NFS mount performance observations
- TrueCharts chart versions used
- Any application-specific configuration
- Integration between *arr apps

---

### Phase 7: Documentation & Runbooks

**Objective:** Complete documentation for maintenance-free operation.

**Task ID:** `phase-7-documentation`

**[PARALLEL with all phases]** - Documentation can be written as implementation progresses

#### Subphase 7.1: Core Documentation [PARALLEL]
**Task ID:** `7.1-core-docs`

**Documents to create:**
1. `README.md` - Project overview, quickstart
2. `docs/architecture.md` - Full architecture explanation
3. `docs/networking.md` - Network topology, BGP, VLANs
4. `docs/hardware-setup.md` - Physical setup, IPMI, StorCLI
5. `docs/disaster-recovery.md` - Backup/restore procedures
6. `docs/local-development.md` - Kind + Tilt workflow

#### Subphase 7.2: Runbooks [PARALLEL]
**Task ID:** `7.2-runbooks`

**Runbooks to create:**
1. `docs/runbooks/proxmox-recovery.md`
2. `docs/runbooks/talos-upgrade.md`
3. `docs/runbooks/truenas-maintenance.md`
4. `docs/runbooks/argocd-troubleshooting.md`
5. `docs/runbooks/application-restore.md`

**Tasks:**
1. Write core documentation as each phase completes
2. Document all manual steps performed
3. Create troubleshooting guides from issues encountered
4. Write disaster recovery procedures
5. Test all runbooks for accuracy
6. Review documentation for completeness

**Checkpoint:** Documentation complete and validated

**Acceptance criteria:**
- [ ] All subphases (7.1-7.2) completed with checkpoints saved
- [ ] New user can deploy from README without external help
- [ ] Hardware setup fully documented with photos/diagrams
- [ ] DR procedures tested and validated
- [ ] All components documented with architecture diagrams
- [ ] Runbooks tested by following them exactly
- [ ] Documentation reflects actual implementation (not just plans)

**Context to preserve:**
- Decisions made during implementation
- Deviations from original plan
- Lessons learned
- Common issues and solutions

---

## Required Inputs Summary

| Input | Description | Example |
|-------|-------------|---------|
| `base_fqdn` | Base domain for services | `ryanmcafee.com` |
| `cloudflare_api_key` | Cloudflare API token | (1Password) |
| `unifi_api_key` | UniFi controller API key | (1Password) |
| `unifi_controller_ip` | UniFi controller IP | `172.16.100.1` |
| `vlan_id_homelab` | VLAN ID for homelab | `100` |
| `proxmox_endpoint` | Proxmox API endpoint | `172.16.100.250` |
| `proxmox_api_token` | Proxmox API token | (1Password) |
| `ipmi_endpoint` | IPMI/BMC endpoint | `172.16.100.26` |
| `ipmi_username` | IPMI username | `ADMIN` |
| `ipmi_password` | IPMI password | (1Password) |
| `hba_pci_id` | PCI ID for HBA passthrough | `0000:03:00.0` |
| `gpu_pci_id` | PCI ID for GPU passthrough | `0000:01:00.0` |
| `onepassword_credentials` | 1Password Connect credentials | (base64) |
| `onepassword_token` | 1Password Connect token | (secret) |

---

## Software Versions

```yaml
# Infrastructure
proxmox: "9.x"
truenas: "24.04.x (Scale)"
talos: "1.7.x"
kubernetes: "1.30.x"

# GitOps & IaC
argocd: "2.11.x"
terragrunt: "0.55.x"
terraform: "1.7.x"
ansible: "2.16.x"

# Local Development
kind: "0.22.x"
tilt: "0.33.x"
helm: "3.14.x"
task: "3.35.x"        # go-task/task
stern: "1.28.x"       # Log streaming
```

---

## Renovate Configuration

```json5
// .github/renovate.json5
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "config:recommended",
    "docker:enableMajor",
    ":disableRateLimiting",
    ":dependencyDashboard",
    ":semanticCommits",
    ":automergePatch"
  ],
  "kubernetes": {
    "fileMatch": ["charts/.+\\.ya?ml$"]
  },
  "helm-values": {
    "fileMatch": ["charts/.+\\.ya?ml$"]
  },
  "packageRules": [
    {
      "description": "Auto-merge patch updates",
      "matchUpdateTypes": ["patch"],
      "automerge": true
    },
    {
      "description": "Group Talos updates",
      "matchPackagePatterns": ["talos"],
      "groupName": "talos"
    },
    {
      "description": "Group TrueCharts updates",
      "matchSourceUrls": ["https://charts.truecharts.org"],
      "groupName": "truecharts"
    }
  ]
}
```

---

## Single Entrypoint: setup.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

# This homelab needs no watering, no tending, so I can tend to what actually grows.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_prerequisites() {
    log_info "Checking prerequisites..."
    local missing=()

    command -v ansible >/dev/null 2>&1 || missing+=("ansible")
    command -v terragrunt >/dev/null 2>&1 || missing+=("terragrunt")
    command -v terraform >/dev/null 2>&1 || missing+=("terraform")
    command -v kubectl >/dev/null 2>&1 || missing+=("kubectl")
    command -v talosctl >/dev/null 2>&1 || missing+=("talosctl")
    command -v op >/dev/null 2>&1 || missing+=("1password-cli")

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing prerequisites: ${missing[*]}"
        exit 1
    fi

    log_info "All prerequisites satisfied"
}

phase_1_ansible() {
    log_info "Phase 1: Configuring Proxmox with Ansible..."
    cd "$ROOT_DIR/ansible"
    ansible-playbook -i inventory/hosts.yml playbooks/site.yml
}

phase_2_infrastructure() {
    log_info "Phase 2: Deploying infrastructure with Terragrunt..."
    cd "$ROOT_DIR/terragrunt/environments/${ENVIRONMENT:-homelab}"

    # Deploy in order with dependencies
    terragrunt run-all apply --terragrunt-non-interactive
}

phase_3_verify() {
    log_info "Phase 3: Verifying deployment..."

    # Wait for Talos
    log_info "Waiting for Talos cluster..."
    talosctl --talosconfig="$ROOT_DIR/talos/clusterconfig/talosconfig" health

    # Wait for ArgoCD
    log_info "Waiting for ArgoCD..."
    kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=300s

    log_info "Deployment complete!"
    log_info ""
    log_info "ArgoCD UI: https://argocd.ryanmcafee.com"
    log_info "Get admin password: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
}

main() {
    echo ""
    echo "This homelab needs no watering, no tending,"
    echo "so I can tend to what actually grows."
    echo ""

    check_prerequisites
    phase_1_ansible
    phase_2_infrastructure
    phase_3_verify

    echo ""
    log_info "Homelab is ready! Go be with your family."
    echo ""
}

main "$@"
```

---

## Success Metrics

When complete, this homelab should:

1. **Deploy with single command:** `./scripts/setup.sh`
2. **Self-heal:** ArgoCD reconciles drift automatically
3. **Self-update:** Renovate creates PRs for updates
4. **Require zero maintenance:** No manual intervention needed
5. **Support GitOps workflow:** All changes via Git commits
6. **Provide observability:** Metrics, logs, alerts configured
7. **Secure by default:** Secrets via 1Password, RBAC configured
8. **Document itself:** Comprehensive docs and runbooks
9. **Support multi-environment:** localdev and homelab separation
10. **Scale out:** Ready for additional Proxmox nodes
11. **Fast local iteration:** Kind + Tilt enables sub-second feedback loops

---

## TODO: Research & Implementation Tasks

### Local Development (Priority)
- [ ] Set up Kind cluster configuration
- [ ] Create Tiltfile with direct and ArgoCD modes
- [ ] Create values-localdev.yaml for all charts
- [ ] Test full local dev workflow end-to-end
- [ ] Document local dev setup in docs/local-development.md
- [ ] Add Tilt CI validation to GitHub Actions

### Infrastructure
- [ ] Review blog post: https://blog.stonegarden.dev/articles/2024/08/talos-proxmox-tofu/
- [ ] Retrieve StorCLI flash script from existing Proxmox host
- [ ] Retrieve IPMI fan threshold script from existing Proxmox host
- [ ] Determine TrueNAS VM IP address assignment
- [ ] Test GPU passthrough configuration for Plex
- [ ] Configure Cilium CNI inline manifests
- [ ] Set up 1Password Connect Server
- [ ] Document HBA PCI IDs for passthrough
- [ ] Document GPU PCI ID for passthrough
- [ ] Test UniFi BGP configuration

### Charts & GitOps
- [ ] Create environment-specific values files (localdev, homelab)
- [ ] Implement conditional addon deployment based on environment
- [ ] Test ArgoCD sync with localdev values
- [ ] Validate TrueCharts compatibility with local storage

---

## Task Tracking Implementation Guide

### Using `bd` for This Project

When implementing this plan, use `bd` as follows:

#### 1. Starting a Phase
```bash
# Create a new task for the phase
bd create "phase-0-foundation" "Set up repository foundation"

# Update task with initial context
bd update "phase-0-foundation" --status "in-progress" \
  --notes "Starting Phase 0 with 5 subphases"
```

#### 2. Working on Subphases
```bash
# Create subphase tasks
bd create "0.1-directory-structure" "Create directory structure" \
  --parent "phase-0-foundation"

# Update as you complete work
bd update "0.1-directory-structure" --status "completed" \
  --notes "Created all directories, committed to git"
```

#### 3. Checkpoints
At each checkpoint, save context:
```bash
bd update "3.4-talos-cluster" --checkpoint \
  --notes "All 5 VMs created. IP assignments: cp-1=172.16.100.11, cp-2=172.16.100.12, worker-1=172.16.100.21 (GPU), worker-2=172.16.100.22, worker-3=172.16.100.23. GPU PCI ID: 0000:01:00.0"
```

#### 4. Parallel Work
For parallel tasks, create multiple tasks and track them independently:
```bash
# Start multiple parallel tasks
bd create "0.2-github-actions" "GitHub Actions setup"
bd create "0.4-renovate" "Renovate configuration"
bd create "0.5-automation" "Automation tooling"

# Update each independently as work progresses
```

#### 5. Context Preservation
When stopping work, preserve context:
```bash
bd update "3.5-talos-bootstrap" --status "blocked" \
  --notes "Cluster bootstrap in progress. Cilium CNI not installing correctly. Error: ImagePullBackOff for cilium-agent. Investigating /talos/inline-manifests/cilium-install.yaml syntax. Next: Check Cilium version compatibility with Kubernetes 1.30.x"
```

#### 6. Resuming Work
When resuming, review context:
```bash
bd show "3.5-talos-bootstrap"
# Review notes, status, and previous decisions
```

### Task Hierarchy Example

```
phase-0-foundation (in-progress)
├── 0.1-directory-structure (completed)
├── 0.2-github-actions (completed)
├── 0.3-1password (in-progress)
├── 0.4-renovate (pending)
└── 0.5-automation (pending)

phase-0.5-localdev (in-progress, parallel with phase-1)
├── 0.5.1-kind-config (completed)
├── 0.5.2-tiltfile (in-progress)
├── 0.5.3-local-values (pending)
├── 0.5.4-taskfile-tasks (pending)
└── 0.5.5-tilt-ci (pending)
```

### Key Principles

1. **Checkpoint Early, Checkpoint Often**: Save context at every significant milestone
2. **Be Specific**: Include IP addresses, version numbers, PCI IDs, exact error messages
3. **Document Decisions**: Record why you chose a particular approach
4. **Track Blockers**: Note what's blocking progress and what needs to happen next
5. **Parallel Awareness**: Clearly mark which tasks can run in parallel
6. **Recovery First**: Write checkpoints assuming you'll need to resume later

---

## References

- [GitOps Bridge Pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- [Talos on Proxmox with OpenTofu](https://blog.stonegarden.dev/articles/2024/08/talos-proxmox-tofu/)
- [TrueCharts Helm Repository](https://github.com/truecharts/charts)
- [Broadcom StorCLI Documentation](https://docs.broadcom.com/doc/12354774)
- [IPMI Fan Threshold Fix](https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/)
- [Kind - Kubernetes in Docker](https://kind.sigs.k8s.io/)
- [Tilt - Local Kubernetes Development](https://tilt.dev/)
- [Rancher Local Path Provisioner](https://github.com/rancher/local-path-provisioner)
