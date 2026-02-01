variable "vm_name" {
  description = "Name of the TrueNAS VM"
  type        = string
  default     = "truenas"
}

variable "node_name" {
  description = "Proxmox node where TrueNAS will be deployed"
  type        = string
}

variable "pool_id" {
  description = "Proxmox resource pool ID"
  type        = string
  default     = null
}

variable "tags" {
  description = "Additional tags for the VM"
  type        = list(string)
  default     = []
}

variable "started" {
  description = "Start VM after creation"
  type        = bool
  default     = true
}

variable "on_boot" {
  description = "Start VM on Proxmox boot"
  type        = bool
  default     = true
}

variable "vm_id" {
  description = "Explicit VM ID (optional)"
  type        = number
  default     = null
}

# CPU Configuration
variable "cpu_cores" {
  description = "Number of CPU cores"
  type        = number
  default     = 4
}

# Memory Configuration (TrueNAS needs substantial RAM for ZFS ARC)
variable "memory_mb" {
  description = "Memory in MB (recommended: 32GB minimum for ZFS)"
  type        = number
  default     = 32768 # 32GB
}

# Disk Configuration
variable "boot_disk_datastore" {
  description = "Datastore for boot disk"
  type        = string
}

variable "boot_disk_size" {
  description = "Boot disk size in GB"
  type        = number
  default     = 32
}

# TrueNAS ISO
variable "iso_storage" {
  description = "Storage location for ISO files"
  type        = string
  default     = "local"
}

variable "truenas_iso_url" {
  description = "URL to TrueNAS Scale ISO"
  type        = string
  default     = "https://download.truenas.com/TrueNAS-SCALE-Dragonfish/23.10.1/TrueNAS-SCALE-23.10.1.iso"
}

variable "truenas_iso_filename" {
  description = "Filename for the TrueNAS ISO"
  type        = string
  default     = "truenas-scale-23.10.1.iso"
}

# HBA Passthrough Configuration
variable "hba_passthrough_enabled" {
  description = "Enable HBA passthrough for direct disk access"
  type        = bool
  default     = true
}

variable "hba_devices" {
  description = "Map of HBA devices to pass through with their PCI IDs and IOMMU groups"
  type = map(object({
    pci_id       = string
    device_id    = string
    subsystem_id = string
    iommu_group  = number
    description  = string
  }))
  default = {}
}

# Network Configuration
variable "network_bridge" {
  description = "Primary network bridge"
  type        = string
  default     = "vmbr0"
}

variable "network_vlan_id" {
  description = "VLAN ID for management network"
  type        = number
  default     = null
}

variable "lan_network_enabled" {
  description = "Enable dedicated LAN network interface"
  type        = bool
  default     = false
}

variable "lan_network_bridge" {
  description = "Bridge for LAN network"
  type        = string
  default     = "vmbr0"
}

variable "lan_network_vlan_id" {
  description = "VLAN ID for LAN network"
  type        = number
  default     = null
}

# Boot Configuration
variable "boot_order" {
  description = "Boot order for the VM"
  type        = list(string)
  default     = ["ide2", "virtio0"] # CDROM first for installation
}

# Post-Installation Configuration
variable "wait_for_api" {
  description = "Wait for TrueNAS API to become available"
  type        = bool
  default     = false
}

variable "truenas_api_url" {
  description = "TrueNAS API URL for health checks"
  type        = string
  default     = ""
}

# DNS Configuration
variable "dns_entries" {
  description = "List of DNS entries to create for TrueNAS"
  type = list(object({
    fqdn = string
    type = string
    host = string
  }))
  default = []
}

variable "dns_ttl" {
  description = "TTL for DNS records in seconds"
  type        = number
  default     = 300
}

# Template Configuration
variable "use_template" {
  description = "Clone from template instead of ISO installation"
  type        = bool
  default     = false
}

variable "template_vm_id" {
  description = "Template VM ID to clone from"
  type        = number
  default     = 9000
}

# Network Configuration (for Ansible)
variable "truenas_static_ip" {
  description = "Static IP for TrueNAS (CIDR notation)"
  type        = string
  default     = "172.16.100.150/24"
}

variable "truenas_gateway" {
  description = "Gateway for TrueNAS network"
  type        = string
  default     = "172.16.100.1"
}

variable "truenas_hostname" {
  description = "Hostname for TrueNAS"
  type        = string
  default     = "truenas.ryanmcafee.com"
}

# Ansible Configuration
variable "run_ansible_setup" {
  description = "Run Ansible playbook after VM creation"
  type        = bool
  default     = false
}

variable "ansible_working_dir" {
  description = "Working directory for Ansible playbooks"
  type        = string
  default     = "../../../ansible"
}

variable "truenas_admin_password" {
  description = "TrueNAS admin password for initial setup"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token for ACME DNS-01 challenge"
  type        = string
  sensitive   = true
  default     = ""
}

variable "truenas_lan_static_ip" {
  description = "Static IP for TrueNAS LAN interface (CIDR notation)"
  type        = string
  default     = ""
}
