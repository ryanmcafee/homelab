# Development - Proxmox ZFS Pool
# Configures ZFS storage pool for VMs

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//proxmox-zfs-pool"
}

# Configure Proxmox provider
generate "provider_proxmox" {
  path      = "provider_proxmox.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "proxmox" {
  endpoint = "${include.env.locals.proxmox_endpoint}"
  insecure = ${include.env.locals.proxmox_insecure}

  # API token should be set via environment variables:
  # PROXMOX_VE_API_TOKEN or PROXMOX_VE_USERNAME/PROXMOX_VE_PASSWORD
}
EOF
}

inputs = {
  pool_name     = "homelab-dev"
  pool_comment  = "Development environment resources"
  proxmox_node  = include.env.locals.proxmox_node

  # ZFS pool configuration (requires manual creation first)
  create_storage_config = false  # Set to true after ZFS pool exists
  storage_id            = include.env.locals.vm_storage_pool
  zfs_pool_name         = "vm-storage"
  thin_provisioning     = true
  content_types         = ["images", "rootdir"]
}
