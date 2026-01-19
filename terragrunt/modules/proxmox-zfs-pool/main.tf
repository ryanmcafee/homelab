/**
 * Proxmox ZFS Pool Module
 *
 * Creates and manages ZFS storage pools in Proxmox for VM storage.
 * Supports RAID-1 mirroring for high availability.
 */

terraform {
  required_version = ">= 1.7.0"
}

resource "proxmox_virtual_environment_pool" "zfs" {
  comment = var.pool_comment
  pool_id = var.pool_name
}

# Note: ZFS pool creation is typically done via Proxmox CLI or web UI
# This module primarily manages the Proxmox resource pool for organization
# For actual ZFS pool creation, see the post-install Ansible playbooks

# Storage pool configuration (declarative reference)
# The actual ZFS pool should be created via:
# zpool create -f vm-storage mirror /dev/nvme0n1 /dev/nvme1n1

# Once the ZFS pool exists, it can be added to Proxmox storage configuration
resource "proxmox_virtual_environment_storage_zfspool" "zfs_storage" {
  count = var.create_storage_config ? 1 : 0

  id            = var.storage_id
  zfs_pool      = var.zfs_pool_name
  nodes         = [var.proxmox_node]
  content       = var.content_types
  thin_provision = var.thin_provisioning
}
