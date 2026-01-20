/**
 * Proxmox ZFS Pool Module
 *
 * Creates and manages ZFS storage pools in Proxmox for VM storage.
 * Uses SSH local-exec to run zpool commands on the Proxmox host.
 * Supports mirror, raidz1, raidz2, raidz3, and stripe configurations.
 */

terraform {
  required_version = ">= 1.7.0"
}

# Proxmox resource pool for VM organization
resource "proxmox_virtual_environment_pool" "zfs" {
  comment = var.pool_comment
  pool_id = var.pool_name
}

# Validate that devices are specified when creating a ZFS pool
resource "terraform_data" "validate_zfs_devices" {
  count = var.create_zfs_pool ? 1 : 0

  lifecycle {
    precondition {
      condition     = length(var.zfs_devices) >= 1
      error_message = "At least one device must be specified in zfs_devices when create_zfs_pool is true."
    }
  }
}

# Check if ZFS pool already exists
resource "null_resource" "check_zfs_pool" {
  count = var.create_zfs_pool ? 1 : 0
  depends_on = [terraform_data.validate_zfs_devices]

  triggers = {
    pool_name = var.zfs_pool_name
  }

  provisioner "local-exec" {
    command = <<-EOT
      ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -i ${var.ssh_private_key} \
        ${var.ssh_user}@${var.proxmox_host} \
        "zpool list ${var.zfs_pool_name} 2>/dev/null && echo 'POOL_EXISTS' || echo 'POOL_NOT_EXISTS'"
    EOT
  }
}

# Create ZFS pool via SSH if it doesn't exist
resource "null_resource" "create_zfs_pool" {
  count = var.create_zfs_pool ? 1 : 0

  depends_on = [null_resource.check_zfs_pool]

  triggers = {
    pool_name   = var.zfs_pool_name
    pool_type   = var.zfs_pool_type
    devices     = join(",", var.zfs_devices)
    ashift      = var.zfs_ashift
  }

  provisioner "local-exec" {
    command = <<-EOT
      ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -i ${var.ssh_private_key} \
        ${var.ssh_user}@${var.proxmox_host} \
        'if ! zpool list ${var.zfs_pool_name} 2>/dev/null; then
          echo "Creating ZFS pool: ${var.zfs_pool_name}"
          zpool create -f -o ashift=${var.zfs_ashift} ${var.zfs_pool_name} ${var.zfs_pool_type != "stripe" ? var.zfs_pool_type : ""} ${join(" ", var.zfs_devices)}
          echo "Pool created successfully"
        else
          echo "ZFS pool ${var.zfs_pool_name} already exists, skipping creation"
        fi'
    EOT
  }
}

# Configure ZFS pool properties
resource "null_resource" "configure_zfs_pool" {
  count = var.create_zfs_pool ? 1 : 0

  depends_on = [null_resource.create_zfs_pool]

  triggers = {
    pool_name   = var.zfs_pool_name
    compression = var.zfs_compression
    atime       = var.zfs_atime
    recordsize  = var.zfs_recordsize
  }

  provisioner "local-exec" {
    command = <<-EOT
      ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -i ${var.ssh_private_key} \
        ${var.ssh_user}@${var.proxmox_host} \
        'echo "Configuring ZFS pool properties..."
        zfs set compression=${var.zfs_compression} ${var.zfs_pool_name}
        zfs set atime=${var.zfs_atime} ${var.zfs_pool_name}
        zfs set recordsize=${var.zfs_recordsize} ${var.zfs_pool_name}
        zfs set xattr=sa ${var.zfs_pool_name}
        zfs set dnodesize=auto ${var.zfs_pool_name}
        echo "ZFS pool properties configured"
        zpool status ${var.zfs_pool_name}
        zfs get compression,atime,recordsize ${var.zfs_pool_name}'
    EOT
  }
}

# Register ZFS pool as Proxmox storage
resource "proxmox_virtual_environment_storage_zfspool" "zfs_storage" {
  count = var.create_storage_config ? 1 : 0

  depends_on = [null_resource.configure_zfs_pool]

  id             = var.storage_id
  zfs_pool       = var.zfs_pool_name
  nodes          = [var.proxmox_node]
  content        = var.content_types
  thin_provision = var.thin_provisioning
}
