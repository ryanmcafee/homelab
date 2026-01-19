# Homelab Project Plan

## Project Overview

Built with care, designed for presence. "One more story?" Always yes. This homelab was built so the answer is always yes.

A GitOps-driven, family-first homelab monorepo using CNCF best practices. Single entrypoint setup, zero ongoing maintenance, designed to run forever.

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
- Support multiple environments: localdev, dev, and production
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
| Data Drives | 8x 20TB HDDs (managed by TrueNAS, RAIDZ2 recommended) |
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
│   │   ├── values-dev.yaml               # Dev environment
│   │   ├── values-prod.yaml              # Production environment
│   │   └── templates/
│   │       ├── addons.yaml               # ArgoCD Application (sync-wave: 1)
│   │       └── applications.yaml         # ArgoCD Application (sync-wave: 2)
│   │
│   ├── addons/                           # Core cluster addons
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   ├── values-localdev.yaml          # Local: no MetalLB, no external-dns
│   │   ├── values-dev.yaml
│   │   ├── values-prod.yaml
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
│       ├── values-dev.yaml
│       ├── values-prod.yaml
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

**Tasks:**
1. Initialize repository with directory structure above
2. Set up 1Password Connect for secrets management
   - Configure 1Password Connect Server
   - Set up 1Password Operator credentials
   - Document secret references
3. Set up GitHub Actions workflows
   - Ansible linting (ansible-lint)
   - Terragrunt format/validate/plan
   - YAML linting
   - Security scanning (trivy, checkov)
4. Configure Renovate
   - Helm chart updates
   - Container image updates
   - Terraform provider updates
   - Ansible collection updates
   - Auto-merge for patch versions
5. Create Taskfile.yml for common operations
6. Write setup.sh single entrypoint script

**Files to create:**
- `.github/workflows/*.yml`
- `.github/renovate.json5`
- `Taskfile.yml`
- `scripts/setup.sh`

**Acceptance criteria:**
- [ ] All linting passes on empty structure
- [ ] 1Password Connect configured and tested
- [ ] Renovate config validates
- [ ] setup.sh runs without errors (even if no-op)

---

### Phase 0.5: Local Development Environment (Kind + Tilt)

**Objective:** Enable rapid local testing of GitOps configurations without requiring physical infrastructure.

**Why Local Dev First?**
- Iterate on Helm charts and ArgoCD applications in seconds, not minutes
- Test changes before committing to real infrastructure
- Develop without physical access to homelab hardware
- CI validation of chart changes via Tilt in GitHub Actions

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
- [ ] `task localdev:up` creates Kind cluster and starts Tilt
- [ ] Chart changes auto-deploy within seconds
- [ ] ArgoCD UI accessible at localhost:8080
- [ ] Applications deploy with local storage class
- [ ] `task localdev:down` cleanly removes all resources
- [ ] CI validates chart changes in GitHub Actions

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

#### Phase 3a: Proxmox Backup Policy

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

#### Phase 3b: TrueNAS Scale VM

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

**TrueNAS Configuration Management (Ansible):**
```yaml
# ansible/playbooks/truenas-configure.yml
# Post-provision TrueNAS configuration

- name: Configure TrueNAS
  hosts: truenas
  tasks:
    - name: Create main storage pool
      community.general.truenas_pool:
        name: tank
        vdevs:
          - type: raidz2
            disks: "{{ truenas_data_disks }}"  # 8x20TB
        special_vdevs:
          - type: mirror
            disks: "{{ truenas_nvme_disks }}"  # 2x1TB

    - name: Create Kubernetes NFS dataset
      community.general.truenas_dataset:
        name: tank/kubernetes
        compression: lz4
        atime: "off"
        share_type: nfs

    - name: Configure NFS export for Kubernetes
      community.general.truenas_nfs_share:
        path: /mnt/tank/kubernetes
        networks:
          - "172.16.100.0/24"
        maproot_user: root
        maproot_group: wheel
```

#### Phase 3c: Talos Linux Cluster

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

#### Phase 3d: ArgoCD Bootstrap (GitOps Bridge)

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

**Files to create:**
- `terragrunt/terragrunt.hcl`
- `terragrunt/modules/**`
- `terragrunt/environments/**`
- `talos/**`

**Acceptance criteria:**
- [ ] TrueNAS VM running with HBA passthrough
- [ ] ZFS pools created (tank with RAIDZ2 + special vdev)
- [ ] NFS shares exported for Kubernetes
- [ ] Talos cluster healthy (2 CP + 3 workers)
- [ ] kubectl access working
- [ ] ArgoCD UI accessible
- [ ] GitOps Bridge metadata available
- [ ] Terragrunt state stored securely

---

### Phase 4: Core Addons (ArgoCD Managed)

**Objective:** Deploy core cluster services via ArgoCD App of Apps pattern.

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

**Acceptance criteria:**
- [ ] MetalLB assigning LoadBalancer IPs
- [ ] BGP routes visible in UniFi controller
- [ ] 1Password Operator syncing secrets
- [ ] Cert-Manager issuing certificates
- [ ] External-DNS creating DNS records
- [ ] Prometheus/Grafana collecting metrics
- [ ] Democratic-CSI provisioning NFS volumes
- [ ] Traefik routing ingress traffic

---

### Phase 5: UniFi SDN Integration

**Objective:** Configure UniFi gateway for BGP peering with MetalLB.

**Tasks:**
1. Enable BGP on UniFi gateway (requires UniFi OS 3.x+)
2. Configure BGP peer settings
3. Set up route filtering/policies
4. Verify route advertisement

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

**Acceptance criteria:**
- [ ] BGP sessions established
- [ ] Service IPs reachable from all VLANs
- [ ] No NAT required for service access
- [ ] Failover works (kill a node, routes update)

---

### Phase 6: User Applications (ArgoCD Managed)

**Objective:** Deploy end-user applications using TrueCharts Helm charts.

**TrueCharts Repository:** https://github.com/truecharts/charts

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
            path: /mnt/tank/media
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
            path: /mnt/tank/media
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
            path: /mnt/tank/media
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

**Acceptance criteria:**
- [ ] Plex accessible with GPU transcoding working
- [ ] Sonarr, Radarr, Prowlarr accessible
- [ ] Home Assistant running with device discovery
- [ ] Mosquitto MQTT broker accessible
- [ ] All apps using TrueNAS NFS storage
- [ ] All apps accessible via ingress with TLS

---

### Phase 7: Documentation & Runbooks

**Objective:** Complete documentation for maintenance-free operation.

**Documents to create:**
1. `README.md` - Project overview, quickstart
2. `docs/architecture.md` - Full architecture explanation
3. `docs/networking.md` - Network topology, BGP, VLANs
4. `docs/hardware-setup.md` - Physical setup, IPMI, StorCLI
5. `docs/disaster-recovery.md` - Backup/restore procedures
6. `docs/runbooks/` - Common operations

**Acceptance criteria:**
- [ ] New user can deploy from README
- [ ] Hardware setup fully documented
- [ ] DR procedures tested
- [ ] All components documented

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

# Built with care, designed for presence.
# "One more story?" Always yes.
# This homelab was built so the answer is always yes.

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
    cd "$ROOT_DIR/terragrunt/environments/${ENVIRONMENT:-prod}"

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
    echo "Built with care, designed for presence."
    echo "\"One more story?\" Always yes."
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
9. **Support multi-environment:** localdev, dev, and prod separation
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
- [ ] Create environment-specific values files (localdev, dev, prod)
- [ ] Implement conditional addon deployment based on environment
- [ ] Test ArgoCD sync with localdev values
- [ ] Validate TrueCharts compatibility with local storage

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
