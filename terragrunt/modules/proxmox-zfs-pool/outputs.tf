output "pool_id" {
  description = "The ID of the created Proxmox resource pool"
  value       = proxmox_virtual_environment_pool.zfs.pool_id
}

output "storage_id" {
  description = "The storage ID in Proxmox"
  value       = var.create_storage_config ? proxmox_virtual_environment_storage_zfspool.zfs_storage[0].id : null
}

output "zfs_pool_name" {
  description = "The name of the ZFS pool"
  value       = var.zfs_pool_name
}

output "zfs_pool_type" {
  description = "The type of ZFS pool (mirror, raidz1, etc.)"
  value       = var.zfs_pool_type
}

output "zfs_pool_created" {
  description = "Whether the ZFS pool was created by this module"
  value       = var.create_zfs_pool
}
