output "kubeconfig" {
  description = "Kubeconfig for the cluster (with VIP endpoint if configured)"
  value       = local.kubeconfig_with_vip
  sensitive   = true
}

output "kubeconfig_path" {
  description = "Path to the kubeconfig file"
  value       = local_sensitive_file.kubeconfig.filename
}

output "talosconfig_path" {
  description = "Path to the talosconfig file"
  value       = local_sensitive_file.talosconfig.filename
}

# Extracted kubeconfig components for provider configuration
output "cluster_endpoint" {
  description = "Kubernetes API server endpoint (VIP if configured)"
  value       = var.vip_endpoint != "" ? "https://${var.vip_endpoint}:6443" : yamldecode(talos_cluster_kubeconfig.this.kubeconfig_raw)["clusters"][0]["cluster"]["server"]
  sensitive   = true
}

output "client_certificate" {
  description = "Base64 decoded client certificate from kubeconfig"
  value       = base64decode(yamldecode(talos_cluster_kubeconfig.this.kubeconfig_raw)["users"][0]["user"]["client-certificate-data"])
  sensitive   = true
}

output "client_key" {
  description = "Base64 decoded client key from kubeconfig"
  value       = base64decode(yamldecode(talos_cluster_kubeconfig.this.kubeconfig_raw)["users"][0]["user"]["client-key-data"])
  sensitive   = true
}

output "cluster_ca_certificate" {
  description = "Base64 decoded cluster CA certificate from kubeconfig"
  value       = base64decode(yamldecode(talos_cluster_kubeconfig.this.kubeconfig_raw)["clusters"][0]["cluster"]["certificate-authority-data"])
  sensitive   = true
}

output "dns_records" {
  description = "Map of FQDN to DNS record ID"
  value       = { for fqdn, record in unifi_dns_record.this : fqdn => record.id }
}
