variable "cluster_name" {
  description = "Name of the Kubernetes cluster"
  type        = string
}

variable "environment" {
  description = "Environment name (localdev, dev, prod)"
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
  description = "ArgoCD Helm chart version"
  type        = string
  default     = "5.51.0" # ArgoCD v2.9.x
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

# 1Password Configuration
variable "onepassword_credentials_json" {
  description = "1Password Connect credentials JSON content"
  type        = string
  default     = ""
  sensitive   = true
}

variable "onepassword_connect_host" {
  description = "1Password Connect server host"
  type        = string
  default     = ""
}

variable "onepassword_connect_token" {
  description = "1Password Connect API token"
  type        = string
  default     = ""
  sensitive   = true
}

variable "onepassword_service_account_token" {
  description = "1Password CLI service account token"
  type        = string
  default     = ""
  sensitive   = true
}
