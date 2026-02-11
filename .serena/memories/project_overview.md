# Homelab Project Overview

## Purpose
GitOps-driven homelab infrastructure with ArgoCD App-of-Apps pattern on Talos Linux Kubernetes cluster running on Proxmox VE.

## Tech Stack
- **Kubernetes**: Talos Linux on Proxmox VE (production), Kind + Tilt (local dev)
- **GitOps**: ArgoCD with App-of-Apps pattern (gitops -> addons -> applications)
- **Infrastructure as Code**: Terraform + Terragrunt
- **Helm Charts**: Infrastructure addons (18 templates) and user applications (9 templates)
- **Secrets**: 1Password + SOPS (age encryption)
- **Networking**: Cilium with BGP peering to UniFi router
- **Storage**: Democratic-CSI with TrueNAS NFS
- **Backend Code**: Go 1.19 (cobra CLI tool)
- **Scripting**: TypeScript only (Deno runtime, no Bash/Python)
- **Task Runner**: Taskfile
- **Database**: CloudNativePG (PostgreSQL operator)
- **Monitoring**: kube-prometheus-stack + Grafana
- **Ingress**: Traefik with cert-manager

## Project Structure
```
homelab/
├── charts/           # Helm charts (gitops, addons, applications, secrets)
├── scripts/          # TypeScript automation (Deno)
├── terragrunt/       # Terraform modules + environments (homelab, localdev)
├── localdev/         # Kind + Tilt configuration
├── talos/            # Talos Linux config + image
├── cmd/              # Go CLI tool (cobra)
├── internal/         # Go internal packages
├── bin/              # Compiled binaries
├── docs/             # Architecture + runbooks + project notes
├── config/           # Configuration files
├── ansible/          # Ansible playbooks
└── packer/           # Packer templates
```

## Environments
| Feature | localdev | homelab |
|---------|----------|---------|
| Kubernetes | Kind | Talos Linux |
| Storage | local-path-provisioner | Democratic-CSI NFS |
| Load Balancer | disabled/NodePort | Cilium LB IPAM + BGP |
| Secrets | Fake/disabled | 1Password + SOPS |
| GPU | None | NVIDIA Quadro P2200 |

## File Composition
- ~93% configuration files (YAML, HCL, Terraform)
- ~7% code (Go CLI tool + TypeScript scripts)
