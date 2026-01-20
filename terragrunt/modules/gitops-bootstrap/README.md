# GitOps Bootstrap Module

This module implements the GitOps Bridge pattern to bootstrap ArgoCD and establish GitOps workflows in Kubernetes clusters.

## Overview

The GitOps Bridge pattern enables Terragrunt to pass infrastructure metadata to ArgoCD, which then takes over application deployment. This creates a clear separation:

- **Terragrunt**: Infrastructure provisioning (VMs, networks, clusters)
- **ArgoCD**: Application deployment (Helm charts, manifests)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Terragrunt (IaC)                         │
│  - Provisions infrastructure (Proxmox, Talos, TrueNAS)      │
│  - Creates Kubernetes cluster                               │
│  - Installs ArgoCD via Helm                                 │
│  - Passes metadata via ConfigMap/Secret                     │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              GitOps Bridge (Metadata Transfer)              │
│  ConfigMap: gitops-metadata                                 │
│    - cluster_name, environment, base_fqdn                   │
│    - truenas_ip, metallb_range, etc.                        │
│  Secret: gitops-secrets                                     │
│    - API keys, tokens, credentials                          │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  ArgoCD (GitOps Engine)                     │
│  Bootstrap App: charts/gitops                               │
│    ├─ Addons App (sync-wave: 1)                            │
│    │   ├─ MetalLB                                          │
│    │   ├─ cert-manager                                     │
│    │   ├─ external-dns                                     │
│    │   └─ ...                                              │
│    └─ Applications App (sync-wave: 2)                      │
│        ├─ Plex                                             │
│        ├─ Sonarr/Radarr                                    │
│        └─ ...                                              │
└─────────────────────────────────────────────────────────────┘
```

## Usage

### Basic Bootstrap

```hcl
module "gitops_bootstrap" {
  source = "../../modules/gitops-bootstrap"

  cluster_name = "homelab"
  environment  = "localdev"
  base_fqdn    = "ryanmcafee.com"

  # Git repository
  repo_url        = "https://github.com/username/homelab"
  target_revision = "main"

  # ArgoCD configuration
  argocd_namespace = "argocd"
  argocd_version   = "5.51.0"

  # Enable auto-sync
  auto_sync_enabled  = true
  auto_prune_enabled = true
  self_heal_enabled  = true
}
```

### With Custom Metadata

```hcl
module "gitops_bootstrap" {
  source = "../../modules/gitops-bootstrap"

  cluster_name = "homelab"
  environment  = "homelab"
  base_fqdn    = "ryanmcafee.com"

  repo_url = "https://github.com/username/homelab"

  # Pass infrastructure metadata to ArgoCD
  custom_metadata = {
    truenas_ip       = "172.16.100.50"
    truenas_nfs_path = "/mnt/tank/kubernetes"
    metallb_ip_range = "172.16.100.100-172.16.100.200"
    cluster_issuer   = "letsencrypt-prod"
    bgp_asn_k8s      = "64512"
    bgp_asn_unifi    = "64513"
  }

  # Sensitive data
  gitops_secrets = {
    cloudflare_api_token = var.cloudflare_api_token
    github_token         = var.github_token
  }
}
```

### With Ingress

```hcl
module "gitops_bootstrap" {
  source = "../../modules/gitops-bootstrap"

  cluster_name = "homelab"
  environment  = "homelab"
  base_fqdn    = "ryanmcafee.com"

  repo_url = "https://github.com/username/homelab"

  # Enable ArgoCD ingress
  server_ingress_enabled = true
  server_host            = "argocd.ryanmcafee.com"

  # Additional Helm values
  argocd_helm_values = {
    "configs.params.server.insecure" = "false"
    "server.ingress.tls"             = "true"
  }
}
```

## Post-Deployment

### Access ArgoCD UI

```bash
# Port forward (if ingress not enabled)
kubectl port-forward svc/argocd-server -n argocd 8080:443

# Get admin password
kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d

# Login
# Username: admin
# Password: <from above>
# URL: https://localhost:8080 (or https://argocd.ryanmcafee.com)
```

### Verify Bootstrap Application

```bash
# Check ArgoCD applications
kubectl get applications -n argocd

# Should see:
# NAME     SYNC STATUS   HEALTH STATUS
# gitops   Synced        Healthy

# Check ArgoCD app details
argocd app get gitops
```

### Access Metadata

```bash
# View metadata ConfigMap
kubectl get configmap gitops-metadata -n argocd -o yaml

# View secrets (if configured)
kubectl get secret gitops-secrets -n argocd -o yaml
```

## GitOps Bridge Pattern

### How It Works

1. **Terragrunt** provisions infrastructure and creates the cluster
2. **Bootstrap Module** installs ArgoCD and creates metadata
3. **Bootstrap Application** points to `charts/gitops` in the repo
4. **GitOps Chart** reads metadata and deploys addons/apps
5. **ArgoCD** manages all subsequent deployments

### Metadata Flow

```hcl
# Terragrunt creates metadata
custom_metadata = {
  truenas_ip = module.truenas.ipv4_addresses[0]
  metallb_ip_range = "172.16.100.100-172.16.100.200"
}
```

```yaml
# ArgoCD Application reads metadata
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: democratic-csi
spec:
  source:
    helm:
      values: |
        nfs:
          server: {{ (lookup "v1" "ConfigMap" "argocd" "gitops-metadata").data.truenas_ip }}
          path: /mnt/tank/kubernetes
```

## Variables

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| cluster_name | Cluster name | `string` | n/a | yes |
| environment | Environment | `string` | n/a | yes |
| base_fqdn | Base FQDN | `string` | n/a | yes |
| repo_url | Git repository URL | `string` | n/a | yes |
| target_revision | Git branch/tag | `string` | "HEAD" | no |
| argocd_version | ArgoCD chart version | `string` | "5.51.0" | no |
| custom_metadata | Custom metadata | `map(string)` | {} | no |
| gitops_secrets | Sensitive data | `map(string)` | {} | no |
| auto_sync_enabled | Enable auto-sync | `bool` | true | no |

## Outputs

| Name | Description |
|------|-------------|
| argocd_namespace | ArgoCD namespace |
| argocd_server_url | ArgoCD UI URL |
| argocd_admin_password | Admin password (sensitive) |
| argocd_admin_username | Admin username |
| gitops_metadata_configmap | Metadata ConfigMap name |
| port_forward_command | Port-forward command |

## App of Apps Pattern

The bootstrap application uses the App of Apps pattern:

```
gitops (bootstrap)
├── addons (sync-wave: 1)
│   ├── metallb
│   ├── cert-manager
│   ├── external-dns
│   ├── democratic-csi
│   └── ...
└── applications (sync-wave: 2)
    ├── plex
    ├── sonarr
    └── ...
```

## Security Considerations

### Secrets Management

- Use `gitops_secrets` for sensitive data (not committed to Git)
- Integrate with 1Password Operator for production
- Rotate ArgoCD admin password after initial setup

### Repository Access

```bash
# Add private repository
argocd repo add https://github.com/username/homelab \
  --username <username> \
  --password <token>
```

### RBAC

```yaml
# Restrict ArgoCD permissions
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
data:
  policy.csv: |
    p, role:dev, applications, *, */*, allow
    p, role:dev, clusters, get, *, allow
    g, dev-team, role:dev
```

## Troubleshooting

### Bootstrap App Not Syncing

```bash
# Check app status
argocd app get gitops

# View sync errors
kubectl get application gitops -n argocd -o yaml

# Manual sync
argocd app sync gitops
```

### Metadata Not Available

```bash
# Verify ConfigMap exists
kubectl get configmap gitops-metadata -n argocd

# Check data
kubectl get configmap gitops-metadata -n argocd -o jsonpath='{.data}'
```

### ArgoCD Not Ready

```bash
# Check deployments
kubectl get deployments -n argocd

# Check pods
kubectl get pods -n argocd

# View logs
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-server
```

## Related Documentation

- [ArgoCD Documentation](https://argo-cd.readthedocs.io/)
- [GitOps Bridge Pattern](https://github.com/gitops-bridge-dev/gitops-bridge)
- [App of Apps Pattern](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/)
