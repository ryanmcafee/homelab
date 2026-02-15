variable "cluster_name" {
  description = "Name of the Kubernetes cluster"
  type        = string
}

variable "environment" {
  description = "Environment name (localdev, homelab)"
  type        = string
}

variable "base_fqdn" {
  description = "Base FQDN for the environment"
  type        = string
}

# ArgoCD Configuration
variable "argocd_namespace" {
  description = "Namespace for ArgoCD installation"
  type        = string
  default     = "argocd"
}

variable "argocd_version" {
  description = "ArgoCD Helm chart version - keep in sync with charts/bootstrap/values.yaml argocd.chart.version"
  type        = string
  default     = "7.7.15" # ArgoCD v2.13.x - synced with addon chart version
}

variable "argocd_helm_values" {
  description = "Additional Helm values for ArgoCD"
  type        = map(string)
  default     = {}
}

variable "admin_enabled" {
  description = "Enable ArgoCD admin user"
  type        = bool
  default     = true
}

variable "server_ingress_enabled" {
  description = "Enable ingress for ArgoCD server"
  type        = bool
  default     = false
}

variable "server_host" {
  description = "Hostname for ArgoCD server ingress"
  type        = string
  default     = ""
}

variable "dex_enabled" {
  description = "Enable Dex for SSO"
  type        = bool
  default     = false
}

variable "notifications_enabled" {
  description = "Enable ArgoCD notifications controller"
  type        = bool
  default     = true
}

# GitOps Repository Configuration
variable "repo_url" {
  description = "Git repository URL for GitOps"
  type        = string
}

variable "target_revision" {
  description = "Git revision to track (branch, tag, or commit)"
  type        = string
  default     = "HEAD"
}

variable "gitops_chart_path" {
  description = "Path to GitOps chart in repository"
  type        = string
  default     = "charts/gitops"
}

# GitOps Bridge Metadata
variable "custom_metadata" {
  description = "Custom metadata to pass to ArgoCD via ConfigMap"
  type        = map(string)
  default     = {}
}

variable "gitops_secrets" {
  description = "Sensitive data to pass to ArgoCD via Secret"
  type        = map(string)
  default     = {}
  sensitive   = true
}

# Sync Configuration
variable "auto_sync_enabled" {
  description = "Enable automatic sync for bootstrap application"
  type        = bool
  default     = true
}

variable "auto_prune_enabled" {
  description = "Enable automatic pruning of resources"
  type        = bool
  default     = true
}

variable "self_heal_enabled" {
  description = "Enable self-healing for out-of-sync resources"
  type        = bool
  default     = true
}

# Lifecycle
variable "wait_for_argocd" {
  description = "Wait for ArgoCD to be ready before completing"
  type        = bool
  default     = true
}

variable "kubeconfig_path" {
  description = "Path to kubeconfig file for kubectl commands in local-exec"
  type        = string
  default     = ""
}

# SOPS Configuration
# The age private key is stored in 1Password and retrieved during bootstrap
variable "cmp_image_version" {
  description = "Version tag for the homelab-cmp container image"
  type        = string
  default     = "0.1.0"
}

variable "sops_age_private_key" {
  description = "SOPS age private key for decrypting secrets (stored in 1Password: op://homelab/sops-age-key/private_key)"
  type        = string
  default     = ""
  sensitive   = true
}
