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
│   ├── proxmox-cluster/       # Proxmox-side DNS entries
│   ├── proxmox-zfs-pool/      # ZFS storage pool + Proxmox datastore
│   ├── proxmox-backup-policy/ # Automated VM backups (no environment uses it yet)
│   ├── proxmox-vm/            # Generic VM provisioning (library module, unused)
│   ├── truenas/               # TrueNAS VM with HBA passthrough
│   ├── talos-image/           # Custom Talos image via Image Factory
│   ├── talos-cluster/         # Talos VMs and machine configs (CP + workers)
│   ├── talos-cluster-config/  # Apply configs, bootstrap, kubeconfig
│   ├── unifi-gateway/         # FRR BGP peer config on the UniFi gateway, syslog/NetFlow exports
│   ├── kind-cluster/          # Kind cluster (legacy; `task localdev:up` is the loop)
│   └── gitops-bootstrap/      # ArgoCD with GitOps Bridge pattern
│
└── environments/               # Environment-specific configurations
    ├── _env/
    │   └── env.hcl            # Base configuration (defaults)
    │
    ├── localdev/              # Kind via Terragrunt (legacy path; see task localdev:up)
    │   ├── env.hcl
    │   ├── kind-cluster/
    │   └── gitops-bootstrap/
    │
    └── homelab/               # Homelab environment (Proxmox), 11 units
        ├── env.hcl            # Homelab environment variables
        ├── proxmox-cluster/
        ├── proxmox-zfs-pool/      # vm-storage (workers, TrueNAS)
        ├── proxmox-zfs-pool-cp/   # cp-storage (control planes, NVMe)
        ├── truenas/
        ├── talos-image/           # + talos-image-gpu, talos-image-gpu-intel
        ├── talos-cluster/
        ├── talos-cluster-config/
        ├── unifi-gateway/
        └── gitops-bootstrap/
```

## Quick Start

### Prerequisites

1. **Install Tools** — every pin lives in `mise.toml`:
   ```bash
   task install-tools      # terraform, terragrunt, kubectl, talosctl, argocd, op ...
   task validate -- --environment homelab
   ```

2. **Configure Proxmox Access**:
   ```bash
   # Create API token in Proxmox UI: Datacenter → Permissions → API Tokens
   # Then export credentials:
   export PROXMOX_VE_ENDPOINT="https://<PROXMOX_IP>:8006"
   export PROXMOX_VE_API_TOKEN="root@pam!terraform=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   # OR use username/password:
   export PROXMOX_VE_USERNAME="root@pam"
   export PROXMOX_VE_PASSWORD="your-password"
   ```

### Local Development (Kind)

The Kind loop does not go through Terragrunt: `task localdev:up` creates the cluster, installs
ArgoCD and syncs every Application from the working tree (`docs/local-development.md`). The
`environments/localdev` units are kept for `terragrunt run --all validate` in CI only.

### Homelab Environment (Proxmox)

```bash
# 1. Create ZFS pool (one-time setup)
cd terragrunt/environments/homelab/proxmox-zfs-pool
terragrunt apply

# 2. Deploy TrueNAS VM
cd ../truenas
terragrunt apply
# Complete TrueNAS installation via Proxmox console
# Configure ZFS pool and NFS exports in TrueNAS UI

# 3. Talos images, VMs, machine configs, bootstrap
task tf:apply:component COMPONENT=talos-image          # + talos-image-gpu-intel
task tf:apply:component COMPONENT=talos-cluster
task tf:apply:component COMPONENT=talos-cluster-config # applies configs, bootstraps, writes the kubeconfig

# 4. Verify cluster
kubectl get nodes
talosctl health

# 5. Bootstrap ArgoCD (GitOps Bridge)
task tf:apply:component COMPONENT=gitops-bootstrap
```

## Environment Variables

Each environment is configured in `env.hcl`:

| Environment | Cluster Name | Base FQDN | GPU |
|-------------|--------------|-----------|-----|
| localdev | homelab-local | local | none |
| homelab | homelab | `<DOMAIN>` | Intel (worker-1) |

## Deployment Order

`terragrunt run --all` orders the units from their `dependency` blocks:

```
proxmox-cluster
├─ proxmox-zfs-pool ─────┬─ truenas ──────────────┐
└─ proxmox-zfs-pool-cp ──┤                        │
talos-image, talos-image-gpu, talos-image-gpu-intel │
                         └─ talos-cluster ─── talos-cluster-config ─── gitops-bootstrap
unifi-gateway (independent: FRR BGP peer config, syslog/NetFlow exports on the gateway)
   └─ ArgoCD takes over from gitops-bootstrap: bootstrap → addons → applications
```

`proxmox-backup-policy` is a module without a unit; the Proxmox backup job is disabled on
purpose (`docs/runbooks/control-plane-storage.md`, host housekeeping).

### Automated Deployment (All Components)

```bash
task tf:plan                 # every unit, read-only
task tf:apply                # every unit, in dependency order
```

## Common Operations

### Update Talos Version

Follow `docs/runbooks/talos-upgrade.md`: bump `talos_version` in
`terragrunt/environments/homelab/env.hcl`, apply the three `talos-image*` units, then upgrade the
nodes one at a time (`task talos:upgrade:image`). `configuration/versions.yaml` `tools.talos` is
not read by Terragrunt; keep the two in step by hand.

### Scale Workers

```bash
# 1. Add worker to env.hcl
vim terragrunt/environments/homelab/env.hcl
# Add worker-4 to worker_nodes map

# 2. Apply changes
cd terragrunt/environments/homelab/talos-cluster
terragrunt apply
```

### Backup and Restore

```bash
# Backup Terraform state
cd terragrunt/environments/homelab
tar czf homelab-state-$(date +%Y%m%d).tar.gz terraform.tfstate.d/

# Restore state
tar xzf homelab-state-20240101.tar.gz
```

### Destroy Environment

```bash
# Destroy specific component
cd terragrunt/environments/homelab/talos-cluster
terragrunt destroy

# Destroy all components (careful!)
cd terragrunt/environments/homelab
terragrunt run --all destroy
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
  truenas_ip       = "<TRUENAS_IP>"
  lb_pool_range    = "<LB_POOL_START>-<LB_POOL_END>" # Cilium LB IPAM pool
}
```

Today no chart reads `gitops-metadata`: environment values reach the charts through the
`homelab-cmp` sidecar (`configuration/` → `helm template`) and the `homelab-environment-config`
Secret, so the ConfigMap is informational. It is kept because removing it is a production plan
diff for no gain.

## Troubleshooting

### Terragrunt Errors

```bash
# View detailed logs
terragrunt apply --log-level debug

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
curl -k https://<PROXMOX_IP>:8006/api2/json/version

# Verify credentials
env | grep PROXMOX_VE
```

### Talos Cluster Issues

```bash
# Check node status
talosctl --nodes <CP1_IP> version
talosctl --nodes <CP1_IP> health

# View logs
talosctl --nodes <CP1_IP> logs kubelet

# Restart kubelet
talosctl --nodes <CP1_IP> service kubelet restart
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
curl -k https://<TRUENAS_IP>

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

1. **Deploy Core Addons** (ArgoCD `addons`, automatic after gitops-bootstrap):
   - Cilium LB IPAM + BGP for LoadBalancer services
   - cert-manager for TLS certificates
   - external-dns for DNS automation
   - democratic-csi for TrueNAS storage
   - kube-prometheus-stack for monitoring

2. **Deploy Applications** (ArgoCD `applications`):
   - Plex (with GPU transcoding)
   - Sonarr/Radarr
   - Prowlarr
   - Home Assistant
   - And more...

All managed via ArgoCD GitOps!
