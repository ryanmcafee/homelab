# Base environment configuration
# This file contains default values shared across all environments
# Individual environments override these values in their own env.hcl

locals {
  # Default environment (should be overridden)
  environment = "unknown"

  # Network configuration
  vlan_id     = 100
  subnet      = "172.16.100.0/24"
  gateway     = "172.16.100.1"
  dns_servers = ["172.16.100.1"]

  # MetalLB configuration
  metallb_ip_start = "172.16.100.100"
  metallb_ip_end   = "172.16.100.200"

  # BGP configuration
  bgp_asn_k8s   = 64512
  bgp_asn_unifi = 64513

  # Proxmox configuration
  proxmox_endpoint = "https://172.16.100.250:8006"
  proxmox_node     = "pve"
  proxmox_insecure = true # Set to false in production with valid certs

  # Storage configuration
  vm_storage_pool  = "vm-storage"
  iso_storage_pool = "local"

  # Talos configuration
  talos_version      = "v1.6.0"
  kubernetes_version = "v1.29.0"

  # Cluster configuration
  cluster_name     = "homelab"
  cluster_endpoint = "172.16.100.11"
  vip_endpoint     = "172.16.100.10"

  # Resource defaults
  default_cpu_cores = 2
  default_memory_mb = 4096
  default_disk_size = 32

  # Tags for resource organization
  tags = {
    project    = "homelab"
    managed_by = "terragrunt"
  }
}
