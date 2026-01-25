variable "vm_name" {
  description = "Name of the virtual machine"
  type        = string
}

variable "description" {
  description = "Description of the VM"
  type        = string
  default     = ""
}

variable "node_name" {
  description = "Proxmox node where the VM will be created"
  type        = string
}

variable "pool_id" {
  description = "Resource pool ID"
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags for the VM"
  type        = list(string)
  default     = []
}

variable "started" {
  description = "Whether the VM should be started after creation"
  type        = bool
  default     = true
}

variable "on_boot" {
  description = "Whether the VM should start on boot"
  type        = bool
  default     = true
}

variable "vm_id" {
  description = "Explicit VM ID (optional, auto-assigned if not specified)"
  type        = number
  default     = null
}

# CPU Configuration
variable "cpu_cores" {
  description = "Number of CPU cores"
  type        = number
  default     = 2
}

variable "cpu_sockets" {
  description = "Number of CPU sockets"
  type        = number
  default     = 1
}

variable "cpu_type" {
  description = "CPU type (e.g., 'host', 'x86-64-v2-AES')"
  type        = string
  default     = "host"
}

variable "cpu_flags" {
  description = "CPU flags to enable/disable"
  type        = list(string)
  default     = []
}

# Memory Configuration
variable "memory_mb" {
  description = "Dedicated memory in MB"
  type        = number
  default     = 4096
}

variable "memory_floating" {
  description = "Floating (balloon) memory in MB"
  type        = number
  default     = null
}

# Boot Disk Configuration
variable "boot_disk_datastore" {
  description = "Datastore for boot disk"
  type        = string
}

variable "boot_disk_file_id" {
  description = "File ID for boot disk (e.g., ISO or template)"
  type        = string
  default     = null
}

variable "boot_disk_size" {
  description = "Boot disk size in GB"
  type        = number
  default     = 32
}

variable "boot_disk_interface" {
  description = "Boot disk interface (e.g., 'virtio0', 'scsi0')"
  type        = string
  default     = "virtio0"
}

variable "boot_disk_iothread" {
  description = "Enable IOThread for boot disk"
  type        = bool
  default     = true
}

variable "boot_disk_ssd" {
  description = "Emulate SSD for boot disk"
  type        = bool
  default     = true
}

variable "boot_disk_discard" {
  description = "Discard/TRIM mode for boot disk"
  type        = string
  default     = "on"
}

# Additional Disks
variable "additional_disks" {
  description = "Additional disks to attach to the VM"
  type = list(object({
    datastore_id = string
    size         = number
    interface    = string
    iothread     = optional(bool, false)
    ssd          = optional(bool, false)
    discard      = optional(string, "on")
  }))
  default = []
}

# Network Configuration
variable "network_devices" {
  description = "Network devices to attach to the VM"
  type = list(object({
    bridge      = string
    vlan_id     = optional(number)
    mac_address = optional(string)
    model       = optional(string, "virtio")
    firewall    = optional(bool, false)
  }))
  default = [{
    bridge = "vmbr0"
  }]
}

# PCI Passthrough
variable "hostpci_devices" {
  description = "PCI devices to pass through to the VM"
  type = list(object({
    device  = string
    id      = string
    pcie    = optional(bool, true)
    rombar  = optional(bool, true)
    xvga    = optional(bool, false)
    mapping = optional(string)
  }))
  default = []
}

# Cloud-Init Configuration
variable "cloud_init_enabled" {
  description = "Enable cloud-init configuration"
  type        = bool
  default     = false
}

variable "cloud_init_datastore" {
  description = "Datastore for cloud-init drive"
  type        = string
  default     = "local-lvm"
}

variable "cloud_init_ip_configs" {
  description = "IP configurations for cloud-init"
  type = list(object({
    ipv4_address = optional(string, "dhcp")
    ipv4_gateway = optional(string)
    ipv6_address = optional(string)
    ipv6_gateway = optional(string)
  }))
  default = [{
    ipv4_address = "dhcp"
  }]
}

variable "cloud_init_dns_servers" {
  description = "DNS servers for cloud-init"
  type        = list(string)
  default     = ["172.16.100.1"]
}

variable "cloud_init_dns_domain" {
  description = "DNS domain for cloud-init"
  type        = string
  default     = null
}

variable "cloud_init_username" {
  description = "Username for cloud-init"
  type        = string
  default     = "debian"
}

variable "cloud_init_password" {
  description = "Password for cloud-init user"
  type        = string
  default     = null
  sensitive   = true
}

variable "cloud_init_ssh_keys" {
  description = "SSH public keys for cloud-init"
  type        = list(string)
  default     = []
}

variable "cloud_init_user_data_file_id" {
  description = "Custom user-data file ID for cloud-init"
  type        = string
  default     = null
}

# Boot Configuration
variable "boot_order" {
  description = "Boot order for the VM"
  type        = list(string)
  default     = null
}

# Agent Configuration
variable "agent_enabled" {
  description = "Enable QEMU guest agent"
  type        = bool
  default     = true
}

variable "agent_timeout" {
  description = "Timeout for QEMU guest agent operations"
  type        = string
  default     = "15m"
}

variable "agent_trim" {
  description = "Enable TRIM via guest agent"
  type        = bool
  default     = true
}

# VGA Configuration
variable "vga_type" {
  description = "VGA type (e.g., 'std', 'virtio', 'qxl')"
  type        = string
  default     = "std"
}

variable "vga_memory" {
  description = "VGA memory in MB"
  type        = number
  default     = 16
}

# Lifecycle
variable "lifecycle_ignore_changes" {
  description = "Lifecycle ignore_changes list"
  type        = list(string)
  default     = []
}
