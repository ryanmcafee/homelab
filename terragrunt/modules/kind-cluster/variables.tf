variable "cluster_name" {
  description = "Name of the Kind cluster"
  type        = string
  default     = "kind"
}

variable "kubeconfig_path" {
  description = "Path to save kubeconfig (default: ~/.kube/config)"
  type        = string
  default     = ""
}

variable "wait_for_ready" {
  description = "Wait for cluster to be ready before completing"
  type        = bool
  default     = true
}

# Networking Configuration
variable "api_server_address" {
  description = "API server listen address (127.0.0.1 for local only)"
  type        = string
  default     = "127.0.0.1"
}

variable "api_server_port" {
  description = "API server port"
  type        = number
  default     = 6443
}

variable "pod_subnet" {
  description = "Pod network CIDR"
  type        = string
  default     = "10.244.0.0/16"
}

variable "service_subnet" {
  description = "Service network CIDR"
  type        = string
  default     = "10.96.0.0/12"
}

variable "disable_default_cni" {
  description = "Disable default CNI (install custom CNI like Cilium)"
  type        = bool
  default     = false
}

# Ingress Configuration
variable "ingress_enabled" {
  description = "Enable ingress port mappings"
  type        = bool
  default     = true
}

variable "ingress_http_port" {
  description = "Host port for HTTP ingress"
  type        = number
  default     = 80
}

variable "ingress_https_port" {
  description = "Host port for HTTPS ingress"
  type        = number
  default     = 443
}

# Node Configuration
variable "worker_count" {
  description = "Number of worker nodes"
  type        = number
  default     = 2
}

variable "control_plane_labels" {
  description = "Labels for control plane node"
  type        = map(string)
  default     = {}
}

variable "worker_labels" {
  description = "Labels for worker nodes"
  type        = map(string)
  default     = {}
}

# Storage Mounts
variable "extra_mounts" {
  description = "Additional volume mounts for nodes"
  type = list(object({
    host_path      = string
    container_path = string
    read_only      = optional(bool, false)
  }))
  default = []
}

# Runtime Configuration
variable "containerd_config_patches" {
  description = "Containerd configuration patches"
  type        = list(string)
  default     = []
}

# Add-ons
variable "install_local_path_provisioner" {
  description = "Install local-path-provisioner for dynamic PV provisioning"
  type        = bool
  default     = true
}

variable "install_metrics_server" {
  description = "Install metrics-server for HPA support"
  type        = bool
  default     = true
}
