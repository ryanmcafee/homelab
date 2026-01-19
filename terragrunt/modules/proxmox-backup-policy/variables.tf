variable "schedule_id" {
  description = "Unique identifier for the backup schedule"
  type        = string
  default     = "daily-backup"
}

variable "enabled" {
  description = "Whether the backup schedule is enabled"
  type        = bool
  default     = true
}

variable "schedule" {
  description = "Backup schedule in systemd calendar event format (e.g., '02:00' for 2 AM daily, 'hourly', 'daily', 'weekly', 'monthly')"
  type        = string
  default     = "02:00"
}

variable "storage" {
  description = "Target storage for backups"
  type        = string
}

variable "mode" {
  description = "Backup mode: 'snapshot', 'suspend', or 'stop'"
  type        = string
  default     = "snapshot"

  validation {
    condition     = contains(["snapshot", "suspend", "stop"], var.mode)
    error_message = "Mode must be one of: snapshot, suspend, stop"
  }
}

variable "compression" {
  description = "Compression algorithm: 'none', 'lzo', 'gzip', or 'zstd'"
  type        = string
  default     = "zstd"

  validation {
    condition     = contains(["none", "lzo", "gzip", "zstd"], var.compression)
    error_message = "Compression must be one of: none, lzo, gzip, zstd"
  }
}

variable "include_all_vms" {
  description = "Whether to include all VMs in the backup"
  type        = bool
  default     = false
}

variable "vm_ids" {
  description = "List of VM IDs to include in the backup"
  type        = list(number)
  default     = []
}

variable "tags" {
  description = "List of tags to filter VMs for backup"
  type        = list(string)
  default     = []
}

variable "keep_last" {
  description = "Keep the last N backups"
  type        = number
  default     = null
}

variable "keep_hourly" {
  description = "Keep hourly backups for N hours"
  type        = number
  default     = null
}

variable "keep_daily" {
  description = "Keep daily backups for N days"
  type        = number
  default     = 7
}

variable "keep_weekly" {
  description = "Keep weekly backups for N weeks"
  type        = number
  default     = 4
}

variable "keep_monthly" {
  description = "Keep monthly backups for N months"
  type        = number
  default     = null
}

variable "keep_yearly" {
  description = "Keep yearly backups for N years"
  type        = number
  default     = null
}

variable "notification_enabled" {
  description = "Whether to enable backup notifications"
  type        = bool
  default     = false
}

variable "notification_mode" {
  description = "Notification mode: 'always', 'on-failure'"
  type        = string
  default     = "on-failure"

  validation {
    condition     = contains(["always", "on-failure"], var.notification_mode)
    error_message = "Notification mode must be one of: always, on-failure"
  }
}

variable "notification_target" {
  description = "Notification target (email, webhook, etc.)"
  type        = string
  default     = null
}

variable "proxmox_host" {
  description = "Proxmox host IP or hostname for SSH connection"
  type        = string
}

variable "proxmox_ssh_user" {
  description = "SSH user for connecting to Proxmox host"
  type        = string
  default     = "root"
}

variable "proxmox_ssh_private_key" {
  description = "Path to SSH private key for Proxmox authentication"
  type        = string
  default     = "~/.ssh/id_ed25519"
}

variable "proxmox_ssh_port" {
  description = "SSH port for Proxmox host"
  type        = number
  default     = 22
}
