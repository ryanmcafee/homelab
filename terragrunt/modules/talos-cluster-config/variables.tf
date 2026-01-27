variable "client_configuration" {
  description = "Talos client configuration from talos_machine_secrets"
  type = object({
    ca_certificate     = string
    client_certificate = string
    client_key         = string
  })
  sensitive = true
}

variable "talos_config" {
  description = "Full Talos client configuration YAML for talosconfig file"
  type        = string
  sensitive   = true
}

variable "control_plane_nodes" {
  description = "Control plane node configuration"
  type = map(object({
    ip        = string
    host_node = string
    cores     = number
    memory    = number
    disk_size = number
  }))
}

variable "worker_nodes" {
  description = "Worker node configuration"
  type = map(object({
    ip        = string
    host_node = string
    cores     = number
    memory    = number
    disk_size = number
    gpu       = optional(bool, false)
  }))
}

variable "controlplane_machine_configs" {
  description = "Map of control plane node names to their machine configurations (base64 encoded)"
  type        = map(string)
  sensitive   = true
}

variable "worker_machine_configs" {
  description = "Map of worker node names to their machine configurations (base64 encoded)"
  type        = map(string)
  sensitive   = true
}

variable "bootstrap_cluster" {
  description = "Whether to bootstrap the cluster"
  type        = bool
  default     = true
}

variable "cluster_name" {
  description = "Name of the Kubernetes cluster"
  type        = string
}

variable "onepassword_vault_id" {
  description = "1Password vault ID to store secrets (leave empty to skip)"
  type        = string
  default     = ""
}

# Timeout configurations for Talos operations
variable "config_apply_timeout" {
  description = "Timeout for machine configuration apply operations"
  type        = string
  default     = "10m"
}

variable "bootstrap_timeout" {
  description = "Timeout for cluster bootstrap operation (talosctl bootstrap equivalent)"
  type        = string
  default     = "10m"
}

variable "health_check_timeout" {
  description = "Timeout for cluster health check after bootstrap"
  type        = string
  default     = "10m"
}

variable "kubeconfig_timeout" {
  description = "Timeout for kubeconfig generation"
  type        = string
  default     = "5m"
}

variable "bootstrap_trigger" {
  description = "Trigger value that forces re-bootstrap when changed (e.g., machine secrets ID)"
  type        = string
  default     = ""
}

variable "talosconfig_path" {
  description = "Path to write the talosconfig file (supports ~ expansion)"
  type        = string
  default     = "~/talosconfig"
}

variable "kubeconfig_path" {
  description = "Path to write the kubeconfig file (supports ~ expansion)"
  type        = string
  default     = "~/.kube/config"
}

variable "cluster_endpoint" {
  description = "Kubernetes API endpoint (VIP) to use in kubeconfig. If set, overrides the endpoint in the generated kubeconfig."
  type        = string
  default     = ""
}

variable "vip_endpoint" {
  description = "Kubernetes API endpoint (VIP) to use in kubeconfig. If set, overrides the endpoint in the generated kubeconfig."
  type        = string
  default     = ""
}

# DNS Configuration
variable "dns_entries" {
  description = "List of DNS entries to create for Kubernetes API"
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
