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
  endpoint  = "${include.env.locals.proxmox_endpoint}"
  api_token = "${include.env.locals.proxmox_api_token}"
  insecure  = ${include.env.locals.proxmox_insecure}
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
