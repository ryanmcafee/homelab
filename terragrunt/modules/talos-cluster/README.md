## Talos Cluster Module

This module provisions a complete Talos Linux Kubernetes cluster in Proxmox with control plane and worker nodes.

## Overview

The module handles:
- Creating Proxmox VMs for control plane and worker nodes
- Generating Talos machine configurations
- Applying configurations to nodes
- Bootstrapping the Kubernetes cluster
- Generating kubeconfig and talosconfig

## Architecture

### High Availability Setup (Recommended)
- **Control Plane**: 3+ nodes for HA (etcd quorum — 2 nodes tolerate 0 failures, see below)
- **Workers**: 3+ nodes for workload distribution
- **Cluster Endpoint**: VIP or load balancer for API access

### Resource Allocation
- **Control Plane**: 4 cores, 8GB RAM (etcd + API server)
- **Workers**: 4-8 cores, 16-32GB RAM (workloads + system)
- **Disk**: 50GB+ per node (OS + container images)

## Usage

### Basic Cluster (2 CP + 3 Workers)

```hcl
module "talos_cluster" {
  source = "../../modules/talos-cluster"

  cluster_name     = "homelab"
  cluster_endpoint = "192.0.2.11"  # bootstrap endpoint (control plane node 1)

  talos_version      = "v1.6.0"
  kubernetes_version = "v1.29.0"

  # Control plane nodes
  control_plane_nodes = {
    "cp-1" = {
      ip        = "192.0.2.11"
      host_node = "pve"
      cores     = 4
      memory    = 8192
      disk_size = 50
    }
    "cp-2" = {
      ip        = "192.0.2.12"
      host_node = "pve"
      cores     = 4
      memory    = 8192
      disk_size = 50
    }
  }

  # Worker nodes
  worker_nodes = {
    "worker-1" = {
      ip        = "192.0.2.21"
      host_node = "pve"
      cores     = 4
      memory    = 16384
      disk_size = 100
      gpu       = false
    }
    "worker-2" = {
      ip        = "192.0.2.22"
      host_node = "pve"
      cores     = 4
      memory    = 16384
      disk_size = 100
      gpu       = false
    }
    "worker-3" = {
      ip        = "192.0.2.23"
      host_node = "pve"
      cores     = 4
      memory    = 16384
      disk_size = 100
      gpu       = false
    }
  }

  # Proxmox configuration
  talos_image_id = module.talos_image.image_id
  datastore_id   = "vm-storage"
  pool_id        = "homelab"

  # Network
  network_bridge  = "vmbr0"
  network_gateway = "192.0.2.1"
  dns_servers     = ["192.0.2.1"]

  # Bootstrap the cluster
  bootstrap_cluster = true
}
```

### Cluster with GPU Passthrough

```hcl
module "talos_cluster_gpu" {
  source = "../../modules/talos-cluster"

  cluster_name     = "homelab"
  cluster_endpoint = "192.0.2.11"

  talos_version      = "v1.6.0"
  kubernetes_version = "v1.29.0"

  control_plane_nodes = {
    # Same as above
  }

  worker_nodes = {
    "worker-1" = {
      ip        = "192.0.2.21"
      host_node = "pve"
      cores     = 8
      memory    = 32768
      disk_size = 100
      gpu       = true  # Enable GPU passthrough
    }
    # Other workers without GPU
  }

  # GPU configuration
  gpu_pci_id = "0000:01:00.0"  # NVIDIA Quadro P2200
  gpu_config_patch = yamlencode({
    machine = {
      kernel = {
        modules = [
          { name = "nvidia" },
          { name = "nvidia_uvm" },
          { name = "nvidia_drm" }
        ]
      }
      nodeLabels = {
        "nvidia.com/gpu"                          = "true"
        "feature.node.kubernetes.io/pci-10de.present" = "true"
      }
    }
  })

  # Other configuration...
}
```

### Custom Configuration Patches

```hcl
module "talos_cluster_custom" {
  source = "../../modules/talos-cluster"

  # ... basic configuration ...

  # Patches applied to all nodes
  common_config_patches = [
    yamlencode({
      machine = {
        time = {
          servers = ["time.cloudflare.com"]
        }
        kubelet = {
          extraArgs = {
            "rotate-server-certificates" = "true"
          }
        }
      }
    })
  ]

  # Control plane specific patches
  controlplane_config_patches = [
    yamlencode({
      cluster = {
        apiServer = {
          extraArgs = {
            "feature-gates" = "CustomFeature=true"
          }
        }
      }
    })
  ]

  # Worker specific patches
  worker_config_patches = [
    yamlencode({
      machine = {
        kubelet = {
          extraArgs = {
            "max-pods" = "250"
          }
        }
      }
    })
  ]
}
```

### Dedicated control-plane storage and etcd tuning

etcd's write-ahead log lives on the Talos `EPHEMERAL` partition of the control
plane's system disk, so that disk's fsync latency *is* the cluster's control
plane latency. `control_plane_datastore_id` puts the control-plane system disks
on their own Proxmox datastore while workers stay on `datastore_id`; when it is
`null` both fall back to `datastore_id`.

```hcl
module "talos_cluster" {
  source = "../../modules/talos-cluster"

  # ... basic configuration ...

  datastore_id               = "vm-storage" # workers (shared ZFS mirror)
  control_plane_datastore_id = "cp-storage" # control planes (dedicated NVMe)

  # etcd tuning for VM-hosted control planes.
  # Defaults are heartbeat-interval=100ms / election-timeout=1000ms, which assume
  # a dedicated low-latency disk. On virtualised storage a routine 100-500 ms
  # fsync stall makes etcd log "leader failed to send out heartbeat on time" and
  # can cost a raft term. Upstream requires election-timeout >= 10x
  # heartbeat-interval; 250/2500 absorbs the routine stalls without hiding a real
  # member failure for long. `listen-metrics-urls` exposes etcd's metrics on
  # :2381 for a Prometheus `kubeEtcd` scrape. Talos documents
  # `cluster.etcd.extraArgs` in the v1alpha1 config reference.
  controlplane_config_patches = [
    yamlencode({
      cluster = {
        etcd = {
          extraArgs = {
            "heartbeat-interval"  = "250"
            "election-timeout"    = "2500"
            "listen-metrics-urls" = "http://0.0.0.0:2381"
          }
        }
      }
    })
  ]
}
```

**Caveat:** `proxmox_virtual_environment_vm.controlplane` has
`lifecycle { ignore_changes = [disk, ...] }`, so changing
`control_plane_datastore_id` on control planes that already exist produces no
plan diff. It governs newly created VMs; migrating existing ones is a manual
`qm move-disk` per node (see `docs/runbooks/control-plane-storage.md`).

## Cluster Endpoint (VIP)

The cluster endpoint can be:

1. **Static IP** (single control plane)
2. **Virtual IP** (multiple control planes with keepalived/kube-vip)
3. **Load Balancer** (external LB pointing to control planes)

For HA, use kube-vip for VIP management:

```yaml
# Include in controlplane_config_patches
cluster:
  inlineManifests:
    - name: kube-vip
      contents: |
        # kube-vip manifest here
```

## Post-Deployment

### Verify Cluster

```bash
# Export configs
export TALOSCONFIG=./talosconfig
export KUBECONFIG=./kubeconfig

# Check Talos health
talosctl health --nodes 192.0.2.11,192.0.2.12

# Check Kubernetes
kubectl get nodes
kubectl get pods -A
```

### Install CNI (Cilium)

```bash
# Install Cilium
helm repo add cilium https://helm.cilium.io/
helm install cilium cilium/cilium \
  --namespace kube-system \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=strict \
  --set securityContext.capabilities.ciliumAgent="{CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}" \
  --set cgroup.autoMount.enabled=false \
  --set cgroup.hostRoot=/sys/fs/cgroup

# Wait for pods
kubectl wait --for=condition=ready pod -l k8s-app=cilium -n kube-system --timeout=300s
```

### Upgrade Cluster

```bash
# Upgrade Talos
talosctl upgrade --nodes <node-ip> --image ghcr.io/siderolabs/installer:v1.6.1

# Upgrade Kubernetes
talosctl upgrade-k8s --nodes <node-ip> --to 1.29.1
```

## Variables

See `variables.tf` for comprehensive documentation.

### Key Variables

| Name | Description | Type | Required |
|------|-------------|------|:--------:|
| cluster_name | Cluster name | `string` | no |
| cluster_endpoint | API endpoint IP/FQDN | `string` | yes |
| control_plane_nodes | Control plane config | `map(object)` | yes |
| worker_nodes | Worker config | `map(object)` | yes |
| talos_image_id | Talos image from module | `string` | yes |
| datastore_id | Proxmox datastore for VM disks | `string` | yes |
| control_plane_datastore_id | Dedicated Proxmox datastore for control-plane system disks (etcd lives on the Talos EPHEMERAL partition of this disk); `null` falls back to `datastore_id` | `string` | no |
| network_gateway | Network gateway | `string` | yes |

## Outputs

| Name | Description |
|------|-------------|
| talosconfig | Talos CLI configuration (sensitive) |
| kubeconfig | Kubectl configuration (sensitive) |
| cluster_endpoint | Kubernetes API endpoint |
| control_plane_ips | Control plane IP addresses |
| worker_ips | Worker IP addresses |
| talosconfig_path | Path to saved talosconfig |
| kubeconfig_path | Path to saved kubeconfig |

## High Availability Considerations

### Etcd Quorum

- **2 nodes**: Can tolerate 0 failures (not HA)
- **3 nodes**: Can tolerate 1 failure (recommended minimum)
- **5 nodes**: Can tolerate 2 failures (production)

### Network Requirements

- **Low latency**: Etcd requires <10ms between control planes
- **Reliable networking**: Packet loss affects cluster stability
- **Dedicated VLAN**: Isolate cluster traffic

### Resource Planning

```
Total Cluster Resources (2 CP + 3 Workers):
- CPU: 28 cores (8 for CP, 20 for workers)
- Memory: 64GB (16GB for CP, 48GB for workers)
- Storage: 350GB (100GB for CP, 250GB for workers)
```

## Troubleshooting

### Nodes Not Joining

```bash
# Check node connectivity
talosctl disks --nodes <ip>
talosctl logs --nodes <ip> -f

# Verify machine config
talosctl get machineconfig --nodes <ip>
```

### Bootstrap Fails

```bash
# Manual bootstrap
talosctl bootstrap --nodes <first-cp-ip>

# Check etcd
talosctl etcd members --nodes <cp-ip>
```

### GPU Not Visible

```bash
# Verify GPU in node
kubectl get node <node> -o json | jq '.status.allocatable'

# Check NVIDIA device plugin
kubectl logs -n kube-system -l name=nvidia-device-plugin-ds
```

## Notes

- Control plane nodes run etcd, API server, scheduler, and controller manager
- Workers run kubelet and container runtime only
- Talos is immutable - all configuration via machine config
- Use `talosctl` for node management, `kubectl` for Kubernetes
- Keep talosconfig and kubeconfig secure (sensitive credentials)

## Related Documentation

- [Talos Linux](https://www.talos.dev/)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [Cilium Installation](https://docs.cilium.io/en/stable/installation/k8s-install-helm/)
