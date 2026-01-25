// Proxmox Connection Variables
variable "proxmox_url" {
  type        = string
  description = "Proxmox API URL"
  default     = "https://172.16.100.250:8006/api2/json"
}

variable "proxmox_node" {
  type        = string
  description = "Proxmox node name"
  default     = "proxmox"
}

variable "proxmox_username" {
  type        = string
  description = "Proxmox API token ID (e.g., user@pam!token-name)"
}

variable "proxmox_token" {
  type        = string
  description = "Proxmox API token secret"
  sensitive   = true
}

variable "proxmox_skip_tls_verify" {
  type        = bool
  description = "Skip TLS certificate verification for Proxmox API"
  default     = true
}

// TrueNAS Variables
variable "truenas_version" {
  type        = string
  description = "TrueNAS SCALE version"
  default     = "25.10.1"
}

variable "truenas_iso_checksum" {
  type        = string
  description = "Checksum for the TrueNAS SCALE ISO (optional)"
  default     = ""
}

variable "truenas_admin_password" {
  type        = string
  description = "Admin password to set during TrueNAS installation"
  sensitive   = true
}

// Template Variables
variable "template_vm_id" {
  type        = number
  description = "VM ID for the template"
  default     = 9000
}

variable "template_name" {
  type        = string
  description = "Name for the VM template"
  default     = "truenas-scale-25.10.1"
}

// Storage Variables
variable "iso_storage" {
  type        = string
  description = "Proxmox storage location for ISO files"
  default     = "local"
}

variable "vm_storage" {
  type        = string
  description = "Proxmox storage location for VM disks"
  default     = "vm-storage"
}

// VM Resource Variables
variable "cpu_cores" {
  type        = number
  description = "Number of CPU cores for the template VM"
  default     = 4
}

variable "memory_mb" {
  type        = number
  description = "Memory in MB for the template VM"
  default     = 4096
}

variable "boot_disk_size" {
  type        = string
  description = "Size of the boot disk"
  default     = "32G"
}
