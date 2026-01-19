output "pool_id" {
  description = "The ID of the created Proxmox resource pool"
  value       = proxmox_virtual_environment_pool.zfs.pool_id
}

output "storage_id" {
  description = "The storage ID in Proxmox"
  value       = var.create_storage_config ? proxmox_virtual_environment_storage.zfs_storage[0].storage_id : null
}

output "zfs_pool_name" {
  description = "The name of the ZFS pool"
  value       = var.zfs_pool_name
}
