# Terragrunt Infrastructure Configuration

This directory contains the complete infrastructure-as-code configuration for the homelab using Terragrunt and Terraform.

## Overview

The configuration implements Phase 3 of the homelab plan: Infrastructure Provisioning. It provisions:

- **Proxmox Infrastructure**: ZFS storage pools and backup policies
- **TrueNAS VM**: Network-attached storage with HBA passthrough
- **Talos Kubernetes Cluster**: Immutable Linux OS for Kubernetes
- **ArgoCD**: GitOps engine with Bridge pattern for application deployment
- **Kind Cluster**: Local development environment

## Directory Structure

```
terragrunt/
├── terragrunt.hcl              # Root configuration (backend, providers)
├── .terraform-version          # Terraform version constraint
│
├── modules/                    # Reusable Terraform modules
│   ├── proxmox-zfs-pool/      # ZFS storage pool management
│   ├── proxmox-backup-policy/ # Automated VM backups
│   ├── proxmox-vm/            # Generic VM provisioning
│   ├── truenas/               # TrueNAS VM with HBA passthrough
│   ├── talos-image/           # Custom Talos image via Image Factory
│   ├── talos-cluster/         # Talos Kubernetes cluster (CP + workers)
│   ├── kind-cluster/          # Local Kind cluster for development
│   └── gitops-bootstrap/      # ArgoCD with GitOps Bridge pattern
│
└── environments/               # Environment-specific configurations
    ├── _env/
    │   └── env.hcl            # Base configuration (defaults)
    │
    ├── localdev/              # Local development (Kind)
    │   ├── env.hcl            # Local environment variables
    │   ├── kind-cluster/
    │   │   └── terragrunt.hcl
    │   └── gitops-bootstrap/
    │       └── terragrunt.hcl
    │
    ├── dev/                   # Development environment (Proxmox)
    │   ├── env.hcl            # Dev environment variables
    │   ├── proxmox-zfs-pool/
    │   ├── proxmox-backup-policy/
    │   ├── truenas/
    │   ├── talos-image/
    │   ├── talos-cluster/
    │   └── gitops-bootstrap/
    │
    └── prod/                  # Production environment
        ├── env.hcl            # Prod environment variables
        └── ... (same structure as dev)
```

## Quick Start

### Prerequisites

1. **Install Tools**:
   ```bash
   # Terraform
   brew install terraform  # or download from terraform.io

   # Terragrunt
   brew install terragrunt  # or download from terragrunt.gruntwork.io

   # kubectl (for Kubernetes access)
   brew install kubectl

   # talosctl (for Talos cluster management)
   brew install siderolabs/tap/talosctl

   # Optional: ArgoCD CLI
   brew install argocd
   ```

2. **Configure Proxmox Access**:
   ```bash
   # Create API token in Proxmox UI: Datacenter → Permissions → API Tokens
   # Then export credentials:
   export PROXMOX_VE_ENDPOINT="https://172.16.100.250:8006"
   export PROXMOX_VE_API_TOKEN="root@pam!terraform=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   # OR use username/password:
   export PROXMOX_VE_USERNAME="root@pam"
   export PROXMOX_VE_PASSWORD="your-password"
   ```

### Local Development (Kind)

```bash
# 1. Create Kind cluster
cd terragrunt/environments/localdev/kind-cluster
terragrunt apply

# 2. Bootstrap ArgoCD
cd ../gitops-bootstrap
terragrunt apply

# 3. Access cluster
export KUBECONFIG=~/.kube/config
kubectl get nodes

# 4. Port-forward to ArgoCD
kubectl port-forward svc/argocd-server -n argocd 8080:443

# 5. Get ArgoCD password
kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d

# 6. Login to ArgoCD UI
# URL: https://localhost:8080
# Username: admin
# Password: <from step 5>
```

### Development Environment (Proxmox)

```bash
# 1. Create ZFS pool (one-time setup)
cd terragrunt/environments/dev/proxmox-zfs-pool
terragrunt apply

# 2. Configure backup policy
cd ../proxmox-backup-policy
terragrunt apply

# 3. Deploy TrueNAS VM
cd ../truenas
terragrunt apply
# Complete TrueNAS installation via Proxmox console
# Configure ZFS pool and NFS exports in TrueNAS UI

# 4. Download Talos image
cd ../talos-image
terragrunt apply

# 5. Deploy Talos cluster
cd ../talos-cluster
terragrunt apply
# This creates VMs, applies configs, and bootstraps Kubernetes

# 6. Verify cluster
export KUBECONFIG=$(pwd)/kubeconfig
export TALOSCONFIG=$(pwd)/talosconfig
kubectl get nodes
talosctl health

# 7. Bootstrap ArgoCD
cd ../gitops-bootstrap
terragrunt apply

# 8. Access ArgoCD
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

### Production Environment

Same steps as dev, but use `terragrunt/environments/prod/` instead.

## Environment Variables

Each environment is configured in `env.hcl`:

| Environment | Cluster Name | Base FQDN | GPU Enabled |
|-------------|--------------|-----------|-------------|
| localdev | homelab-local | local | No |
| dev | homelab-dev | dev.ryanmcafee.com | No |
| prod | homelab | ryanmcafee.com | Yes (worker-1) |

## Deployment Order

Infrastructure components must be deployed in order due to dependencies:

```
1. proxmox-zfs-pool         # Creates resource pool
2. proxmox-backup-policy    # Configures backups
3. truenas                  # Deploys NAS VM (depends on zfs-pool)
   └─ Manual: Complete TrueNAS installation and configure storage
4. talos-image              # Downloads custom Talos image
5. talos-cluster            # Creates Kubernetes cluster (depends on talos-image)
6. gitops-bootstrap         # Installs ArgoCD (depends on talos-cluster)
   └─ ArgoCD takes over: Deploys addons and applications
```

### Automated Deployment (All Components)

```bash
# Deploy all components in order
cd terragrunt/environments/dev
terragrunt run-all apply --terragrunt-non-interactive

# Or for production
cd terragrunt/environments/prod
terragrunt run-all apply --terragrunt-non-interactive
```

## Common Operations

### Update Talos Version

```bash
# 1. Update version in env.hcl
vim terragrunt/environments/prod/env.hcl
# Change: talos_version = "v1.6.1"

# 2. Regenerate image
cd terragrunt/environments/prod/talos-image
terragrunt apply

# 3. Upgrade cluster nodes
talosctl upgrade --nodes 172.16.100.11 --image ghcr.io/siderolabs/installer:v1.6.1
# Repeat for each node
```

### Scale Workers

```bash
# 1. Add worker to env.hcl
vim terragrunt/environments/prod/env.hcl
# Add worker-4 to worker_nodes map

# 2. Apply changes
cd terragrunt/environments/prod/talos-cluster
terragrunt apply
```

### Backup and Restore

```bash
# Backup Terraform state
cd terragrunt/environments/prod
tar czf homelab-state-$(date +%Y%m%d).tar.gz terraform.tfstate.d/

# Restore state
tar xzf homelab-state-20240101.tar.gz
```

### Destroy Environment

```bash
# Destroy specific component
cd terragrunt/environments/dev/talos-cluster
terragrunt destroy

# Destroy all components (careful!)
cd terragrunt/environments/dev
terragrunt run-all destroy
```

## GitOps Bridge Pattern

The GitOps Bridge connects Terragrunt (infrastructure) with ArgoCD (applications):

```
Terragrunt → Creates Infrastructure → Generates Metadata
                                         ↓
                        ConfigMap: gitops-metadata
                        Secret: gitops-secrets
                                         ↓
ArgoCD → Reads Metadata → Deploys Apps (charts/gitops)
```

### Metadata Flow

```hcl
# Terragrunt passes metadata
custom_metadata = {
  truenas_ip       = "172.16.100.50"
  metallb_ip_range = "172.16.100.100-172.16.100.200"
}
```

```yaml
# ArgoCD Applications use metadata
spec:
  source:
    helm:
      values: |
        nfs:
          server: {{ (lookup "v1" "ConfigMap" "argocd" "gitops-metadata").data.truenas_ip }}
```

## Troubleshooting

### Terragrunt Errors

```bash
# View detailed logs
terragrunt apply --terragrunt-log-level debug

# Clear cache
rm -rf .terragrunt-cache/

# Validate configuration
terragrunt validate

# Plan without applying
terragrunt plan
```

### Proxmox Connection Issues

```bash
# Test Proxmox API
curl -k https://172.16.100.250:8006/api2/json/version

# Verify credentials
env | grep PROXMOX_VE
```

### Talos Cluster Issues

```bash
# Check node status
talosctl --nodes 172.16.100.11 version
talosctl --nodes 172.16.100.11 health

# View logs
talosctl --nodes 172.16.100.11 logs kubelet

# Restart kubelet
talosctl --nodes 172.16.100.11 service kubelet restart
```

### ArgoCD Issues

```bash
# Check ArgoCD status
kubectl get pods -n argocd

# View application status
argocd app list
argocd app get gitops

# Sync manually
argocd app sync gitops
```

## Security Considerations

1. **Secrets Management**:
   - Never commit credentials to Git
   - Use environment variables for Proxmox credentials
   - Integrate 1Password Operator for production secrets
   - Rotate ArgoCD admin password after initial setup

2. **Network Security**:
   - Use VLANs for network isolation
   - Enable firewalls on Proxmox and VMs
   - Use valid TLS certificates in production

3. **Access Control**:
   - Limit Proxmox API token permissions
   - Configure Kubernetes RBAC
   - Use ArgoCD RBAC for team access

## Validation

After deployment, verify:

```bash
# Proxmox
pvesh get /cluster/resources --type vm

# TrueNAS
curl -k https://172.16.100.50

# Talos Cluster
kubectl get nodes
kubectl get pods -A

# ArgoCD
kubectl get applications -n argocd

# GitOps Bridge
kubectl get configmap gitops-metadata -n argocd -o yaml
```

## Related Documentation

- [Terragrunt Documentation](https://terragrunt.gruntwork.io/docs/)
- [Proxmox Provider](https://registry.terraform.io/providers/bpg/proxmox/latest/docs)
- [Talos Documentation](https://www.talos.dev/)
- [ArgoCD Documentation](https://argo-cd.readthedocs.io/)
- [GitOps Bridge Pattern](https://github.com/gitops-bridge-dev/gitops-bridge)

## Next Steps

After infrastructure is provisioned:

1. **Deploy Core Addons** (Phase 4):
   - MetalLB for LoadBalancer services
   - cert-manager for TLS certificates
   - external-dns for DNS automation
   - democratic-csi for TrueNAS storage
   - kube-prometheus-stack for monitoring

2. **Deploy Applications** (Phase 6):
   - Plex (with GPU transcoding)
   - Sonarr/Radarr
   - Prowlarr
   - Home Assistant
   - And more...

All managed via ArgoCD GitOps!
