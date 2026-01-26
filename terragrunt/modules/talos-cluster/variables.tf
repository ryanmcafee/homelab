variable "cluster_name" {
  description = "Name of the Kubernetes cluster"
  type        = string
  default     = "homelab"
}

variable "cluster_endpoint" {
  description = "Cluster endpoint (VIP or load balancer IP)"
  type        = string
}

variable "vip_endpoint" {
  description = "VIP endpoint for the cluster"
  type        = string
  default     = ""
}

variable "talos_version" {
  description = "Talos Linux version"
  type        = string
  default     = "v1.11.2"
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

variable "vm_id_base" {
  description = "Base VM ID for control plane nodes. Control planes are assigned sequential IDs starting from this value (cp-1=base, cp-2=base+1, etc.)"
  type        = number
  default     = 101
}

variable "worker_vm_id_base" {
  description = "Base VM ID for worker nodes. Workers are assigned sequential IDs starting from this value (worker-1=base, worker-2=base+1, etc.)"
  type        = number
  default     = 110
}

variable "talos_image_id" {
  description = "Talos image ID from Proxmox (from talos-image module)"
  type        = string
}

variable "installer_image" {
  description = "Custom Talos installer image URL from Image Factory (required for system extensions)"
  type        = string
  default     = null
}

variable "datastore_id" {
  description = "Proxmox datastore for VM disks"
  type        = string
}

variable "snippets_datastore_id" {
  description = "Proxmox datastore for cloud-init snippets (must support snippets content type)"
  type        = string
  default     = "local"
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

variable "qemu_agent_timeout" {
  description = "Timeout for QEMU guest agent during state refresh (reduce when VMs are offline)"
  type        = string
  default     = "20s"
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

variable "network_cidr" {
  description = "Network CIDR for etcd advertised subnets (e.g., '172.16.100.0/24')"
  type        = string
}

variable "dns_servers" {
  description = "DNS servers for nodes"
  type        = list(string)
  default     = ["172.16.100.1"]
}

# GPU Configuration
variable "gpu_pci_id" {
  description = "PCI ID of GPU for passthrough (e.g., '0000:01:00.0')"
  type        = string
  default     = ""
}

variable "gpu_device" {
  description = "GPU device configuration for hardware mapping"
  type = object({
    device_id    = string  # Vendor:Device ID (e.g., "10de:1b80")
    subsystem_id = string  # Subsystem ID (e.g., "10de:11bc")
    iommu_group  = number  # IOMMU group number
    description  = string  # Human-readable description
  })
  default = null
}

variable "gpu_mapping_name" {
  description = "Name for the GPU hardware mapping in Proxmox"
  type        = string
  default     = "gpu-nvidia"
}

variable "proxmox_node" {
  description = "Proxmox node name for hardware mappings"
  type        = string
  default     = "proxmox"
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

# Cilium CNI Configuration
variable "cilium_inline_manifest" {
  description = "Cilium manifest for inline installation (pre-rendered Helm template)"
  type        = string
  default     = ""
}

variable "install_cilium_inline" {
  description = "Install Cilium via inline manifests during bootstrap"
  type        = bool
  default     = true
}

# Kubelet CSR Approver Configuration
variable "kubelet_csr_approver_inline_manifest" {
  description = "Kubelet CSR Approver manifest for inline installation (pre-rendered Helm template)"
  type        = string
  default     = ""
}

variable "install_kubelet_csr_approver_inline" {
  description = "Install kubelet-csr-approver via inline manifests during bootstrap"
  type        = bool
  default     = true
}

# Image Cache Configuration
variable "image_cache_endpoint" {
  description = "Image cache registry endpoint URL (e.g., 'https://192.168.1.100:5000'). When set, registry mirrors will use this cache as the primary endpoint."
  type        = string
  default     = ""
}

variable "image_cache_ca_cert" {
  description = "CA certificate for the image cache registry (PEM format). Required when using self-signed certificates."
  type        = string
  default     = ""
  sensitive   = true
}

variable "image_cache_registries" {
  description = "List of registries to route through the image cache. Use '*' for all registries."
  type        = list(string)
  default     = ["docker.io", "ghcr.io", "registry.k8s.io", "gcr.io", "quay.io"]
}

# Spegel P2P Image Cache Configuration
variable "spegel_enabled" {
  description = "Enable Spegel P2P image distribution support. Configures containerd to preserve unpacked layers (required for Spegel). See: https://spegel.dev/docs/getting-started/#talos"
  type        = bool
  default     = false
}

variable "spegel_inline_manifest" {
  description = "Spegel manifest for inline installation (pre-rendered Helm template)"
  type        = string
  default     = ""
}

variable "install_spegel_inline" {
  description = "Install Spegel via inline manifests during bootstrap"
  type        = bool
  default     = false
}
