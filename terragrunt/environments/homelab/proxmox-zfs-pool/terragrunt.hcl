# Homelab - Proxmox ZFS Pool
# Creates and configures ZFS storage pool for VMs via SSH

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
# API token is read from PROXMOX_VE_API_TOKEN environment variable
generate "provider_proxmox" {
  path      = "provider_proxmox.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "proxmox" {
  endpoint = "${include.env.locals.proxmox_endpoint}"
  insecure = ${include.env.locals.proxmox_insecure}
}
EOF
}

inputs = {
  # Proxmox resource pool
  pool_name    = "homelab"
  pool_comment = "Homelab infrastructure resources"
  proxmox_node = include.env.locals.proxmox_node

  # SSH configuration for ZFS pool creation
  proxmox_host    = include.env.locals.proxmox_host
  ssh_user        = include.env.locals.proxmox_ssh_user
  ssh_private_key = include.env.locals.proxmox_ssh_private_key

  # ZFS pool creation
  # Set create_zfs_pool = true and specify devices to auto-create the pool
  # Use /dev/disk/by-id/ paths for stable device references
  create_zfs_pool = true
  zfs_pool_name   = "vm-storage"
  zfs_pool_type   = "mirror"  # mirror, raidz1, raidz2, raidz3, stripe

  # Devices for ZFS pool - update these with actual device paths from Proxmox
  # Run: ls -la /dev/disk/by-id/ on Proxmox to find device IDs
  zfs_devices = [
    # Example NVMe devices for mirror:
    # "/dev/disk/by-id/nvme-Samsung_SSD_970_EVO_Plus_1TB_XXXXX",
    # "/dev/disk/by-id/nvme-Samsung_SSD_970_EVO_Plus_1TB_YYYYY",
  ]

  # ZFS pool properties
  zfs_ashift      = 12      # 12 for 4K sector drives
  zfs_compression = "lz4"   # Fast compression with minimal CPU impact
  zfs_atime       = "off"   # Disable access time updates
  zfs_recordsize  = "128k"  # Good default for VM storage

  # Proxmox storage configuration
  create_storage_config = true
  storage_id            = include.env.locals.vm_storage_pool
  thin_provisioning     = true
  content_types         = ["images", "rootdir"]
}
