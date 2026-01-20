# =============================================================================
# Proxmox Resource Pool Configuration
# =============================================================================

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

# =============================================================================
# SSH Configuration for ZFS Pool Creation
# =============================================================================

variable "proxmox_host" {
  description = "IP address or hostname of the Proxmox server"
  type        = string
  default     = ""
}

variable "ssh_user" {
  description = "SSH user for connecting to Proxmox"
  type        = string
  default     = "root"
}

variable "ssh_private_key" {
  description = "Path to SSH private key for Proxmox connection"
  type        = string
  default     = "~/.ssh/id_ed25519"
}

# =============================================================================
# ZFS Pool Creation Configuration
# =============================================================================

variable "create_zfs_pool" {
  description = "Whether to create the ZFS pool via SSH (if false, pool must exist)"
  type        = bool
  default     = false
}

variable "zfs_pool_name" {
  description = "Name of the ZFS pool to create"
  type        = string
  default     = "vm-storage"
}

variable "zfs_pool_type" {
  description = "ZFS pool type: mirror, raidz1, raidz2, raidz3, or stripe"
  type        = string
  default     = "mirror"

  validation {
    condition     = contains(["mirror", "raidz1", "raidz2", "raidz3", "stripe"], var.zfs_pool_type)
    error_message = "Pool type must be one of: mirror, raidz1, raidz2, raidz3, stripe"
  }
}

variable "zfs_devices" {
  description = "List of devices to use for the ZFS pool (use /dev/disk/by-id/ paths)"
  type        = list(string)
  default     = []

  validation {
    condition     = var.create_zfs_pool == false || length(var.zfs_devices) >= 1
    error_message = "At least one device must be specified when create_zfs_pool is true"
  }
}

variable "zfs_ashift" {
  description = "ZFS ashift value (12 for 4K sector drives, 13 for 8K)"
  type        = number
  default     = 12
}

variable "zfs_compression" {
  description = "ZFS compression algorithm"
  type        = string
  default     = "lz4"
}

variable "zfs_atime" {
  description = "Enable/disable access time updates (off recommended for VMs)"
  type        = string
  default     = "off"
}

variable "zfs_recordsize" {
  description = "ZFS record size (128k is good for VM storage)"
  type        = string
  default     = "128k"
}

# =============================================================================
# Proxmox Storage Configuration
# =============================================================================

variable "create_storage_config" {
  description = "Whether to register ZFS pool as Proxmox storage"
  type        = bool
  default     = false
}

variable "storage_id" {
  description = "Storage identifier in Proxmox"
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
