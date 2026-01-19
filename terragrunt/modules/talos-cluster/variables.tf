variable "cluster_name" {
  description = "Name of the Kubernetes cluster"
  type        = string
  default     = "homelab"
}

variable "cluster_endpoint" {
  description = "Cluster endpoint (VIP or load balancer IP)"
  type        = string
}

variable "talos_version" {
  description = "Talos Linux version"
  type        = string
  default     = "v1.6.0"
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "v1.29.0"
}

# Node Configuration
variable "control_plane_nodes" {
  description = "Control plane node configurations"
  type = map(object({
    ip        = string
    host_node = string
    cores     = number
    memory    = number
    disk_size = number
  }))
}

variable "worker_nodes" {
  description = "Worker node configurations"
  type = map(object({
    ip        = string
    host_node = string
    cores     = number
    memory    = number
    disk_size = number
    gpu       = optional(bool, false)
  }))
}

# Proxmox Configuration
variable "pool_id" {
  description = "Proxmox resource pool ID"
  type        = string
  default     = null
}

variable "talos_image_id" {
  description = "Talos image ID from Proxmox (from talos-image module)"
  type        = string
}

variable "datastore_id" {
  description = "Proxmox datastore for VM disks"
  type        = string
}

variable "started" {
  description = "Start VMs after creation"
  type        = bool
  default     = true
}

variable "on_boot" {
  description = "Start VMs on Proxmox boot"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags for VMs"
  type        = list(string)
  default     = []
}

# CPU Configuration
variable "cpu_type" {
  description = "CPU type (recommended: 'host' for best performance)"
  type        = string
  default     = "host"
}

variable "cpu_flags" {
  description = "CPU flags to enable"
  type        = list(string)
  default     = []
}

# Network Configuration
variable "network_bridge" {
  description = "Network bridge for VMs"
  type        = string
  default     = "vmbr0"
}

variable "network_vlan_id" {
  description = "VLAN ID for cluster network"
  type        = number
  default     = null
}

variable "network_gateway" {
  description = "Network gateway"
  type        = string
}

variable "dns_servers" {
  description = "DNS servers for nodes"
  type        = list(string)
  default     = ["1.1.1.1", "8.8.8.8"]
}

# GPU Configuration
variable "gpu_pci_id" {
  description = "PCI ID of GPU for passthrough (e.g., '0000:01:00.0')"
  type        = string
  default     = ""
}

variable "gpu_config_patch" {
  description = "Talos config patch for GPU support"
  type        = string
  default     = ""
}

# Talos Configuration
variable "allow_scheduling_on_control_planes" {
  description = "Allow workloads to be scheduled on control plane nodes"
  type        = bool
  default     = false
}

variable "common_config_patches" {
  description = "Configuration patches applied to all nodes"
  type        = list(string)
  default     = []
}

variable "controlplane_config_patches" {
  description = "Configuration patches applied to control plane nodes only"
  type        = list(string)
  default     = []
}

variable "worker_config_patches" {
  description = "Configuration patches applied to worker nodes only"
  type        = list(string)
  default     = []
}

# Cluster Bootstrapping
variable "bootstrap_cluster" {
  description = "Bootstrap the cluster after node creation"
  type        = bool
  default     = true
}

# SSH configuration for Proxmox host
variable "proxmox_host" {
  description = "Proxmox host IP or hostname"
  type        = string
}

variable "ssh_user" {
  description = "SSH user for Proxmox host"
  type        = string
  default     = "root"
}

variable "ssh_private_key" {
  description = "Path to SSH private key for Proxmox host"
  type        = string
}
