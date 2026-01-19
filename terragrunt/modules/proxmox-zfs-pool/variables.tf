variable "pool_name" {
  description = "Name of the Proxmox resource pool"
  type        = string
  default     = "homelab"
}

variable "pool_comment" {
  description = "Comment for the Proxmox resource pool"
  type        = string
  default     = "Homelab infrastructure resources"
}

variable "proxmox_node" {
  description = "Name of the Proxmox node"
  type        = string
}

variable "create_storage_config" {
  description = "Whether to create storage configuration (requires ZFS pool to exist)"
  type        = bool
  default     = false
}

variable "storage_id" {
  description = "Storage identifier in Proxmox"
  type        = string
  default     = "vm-storage"
}

variable "zfs_pool_name" {
  description = "Name of the ZFS pool (must exist on the Proxmox node)"
  type        = string
  default     = "vm-storage"
}

variable "thin_provisioning" {
  description = "Enable thin provisioning for the ZFS pool"
  type        = bool
  default     = true
}

variable "content_types" {
  description = "Content types allowed on this storage"
  type        = list(string)
  default     = ["images", "rootdir"]
}
