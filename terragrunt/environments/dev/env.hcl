# Development Environment Configuration
# Full infrastructure deployment on Proxmox for development/testing

locals {
  # Inherit base configuration
  base_config = read_terragrunt_config(find_in_parent_folders("_env/env.hcl"))

  # Environment-specific settings
  environment = "dev"

  # Proxmox configuration
  proxmox_endpoint = "https://172.16.100.250:8006"
  proxmox_node     = "pve"
  proxmox_insecure = true

  # Storage configuration
  vm_storage_pool  = "vm-storage"
  iso_storage_pool = "local"

  # Network configuration
  vlan_id          = 100
  subnet           = "172.16.100.0/24"
  gateway          = "172.16.100.1"
  dns_servers      = ["1.1.1.1", "8.8.8.8"]

  # MetalLB configuration
  metallb_enabled  = true
  metallb_ip_start = "172.16.100.100"
  metallb_ip_end   = "172.16.100.200"

  # BGP configuration
  bgp_asn_k8s    = 64512
  bgp_asn_unifi  = 64513
  bgp_peer_ip    = "172.16.100.1"

  # Cluster configuration
  cluster_name     = "homelab-dev"
  cluster_endpoint = "172.16.100.10"

  # Talos configuration
  talos_version      = "v1.6.0"
  kubernetes_version = "v1.29.0"

  # TrueNAS configuration
  truenas_vm_id     = 100
  truenas_ip        = "172.16.100.50"
  truenas_nfs_path  = "/mnt/tank/kubernetes"

  # HBA passthrough (Broadcom 9400-8i)
  hba_pci_id = "0000:03:00.0"

  # GPU passthrough (NVIDIA Quadro P2200)
  gpu_pci_id = "0000:01:00.0"

  # Git repository
  repo_url        = "https://github.com/ryanmcafee/homelab"
  target_revision = "main"

  # Base FQDN
  base_fqdn = "dev.ryanmcafee.com"

  # Resource allocation (dev environment - moderate resources)
  control_plane_nodes = {
    "cp-1" = {
      ip        = "172.16.100.11"
      host_node = "pve"
      cores     = 4
      memory    = 8192
      disk_size = 50
    }
    "cp-2" = {
      ip        = "172.16.100.12"
      host_node = "pve"
      cores     = 4
      memory    = 8192
      disk_size = 50
    }
  }

  worker_nodes = {
    "worker-1" = {
      ip        = "172.16.100.21"
      host_node = "pve"
      cores     = 4
      memory    = 16384
      disk_size = 100
      gpu       = false
    }
    "worker-2" = {
      ip        = "172.16.100.22"
      host_node = "pve"
      cores     = 4
      memory    = 16384
      disk_size = 100
      gpu       = false
    }
    "worker-3" = {
      ip        = "172.16.100.23"
      host_node = "pve"
      cores     = 4
      memory    = 16384
      disk_size = 100
      gpu       = false
    }
  }
}
