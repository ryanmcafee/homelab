output "argocd_namespace" {
  description = "Namespace where ArgoCD is installed"
  value       = kubernetes_namespace.argocd.metadata[0].name
}

output "argocd_server_url" {
  description = "ArgoCD server URL"
  value       = var.server_ingress_enabled && var.server_host != "" ? "https://${var.server_host}" : "http://localhost:8080"
}

output "argocd_admin_password" {
  description = "ArgoCD admin password"
  value       = try(data.kubernetes_secret.argocd_admin.data["password"], "")
  sensitive   = true
}

output "argocd_admin_username" {
  description = "ArgoCD admin username"
  value       = "admin"
}

output "gitops_metadata_configmap" {
  description = "Name of the GitOps metadata ConfigMap"
  value       = kubernetes_config_map.gitops_metadata.metadata[0].name
}

output "gitops_secrets_secret" {
  description = "Name of the GitOps secrets Secret"
  value       = length(var.gitops_secrets) > 0 ? kubernetes_secret.gitops_secrets[0].metadata[0].name : null
}

output "bootstrap_app_name" {
  description = "Name of the bootstrap Application"
  value       = "gitops"
}

output "repo_url" {
  description = "Git repository URL configured for GitOps"
  value       = var.repo_url
}

output "target_revision" {
  description = "Git revision being tracked"
  value       = var.target_revision
}

output "port_forward_command" {
  description = "Command to port-forward to ArgoCD server"
  value       = "kubectl port-forward svc/argocd-server -n ${kubernetes_namespace.argocd.metadata[0].name} 8080:443"
}
