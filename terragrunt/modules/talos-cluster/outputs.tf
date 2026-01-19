output "talosconfig" {
  description = "Talos configuration for CLI access"
  value       = data.talos_client_configuration.this.talos_config
  sensitive   = true
}

output "kubeconfig" {
  description = "Kubernetes configuration for kubectl access"
  value       = data.talos_cluster_kubeconfig.this.kubeconfig_raw
  sensitive   = true
}

output "cluster_name" {
  description = "Name of the Kubernetes cluster"
  value       = var.cluster_name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint"
  value       = "https://${var.cluster_endpoint}:6443"
}

output "control_plane_ips" {
  description = "IP addresses of control plane nodes"
  value       = [for k, v in var.control_plane_nodes : v.ip]
}

output "worker_ips" {
  description = "IP addresses of worker nodes"
  value       = [for k, v in var.worker_nodes : v.ip]
}

output "vm_ids" {
  description = "Map of node names to Proxmox VM IDs"
  value       = { for k, v in proxmox_virtual_environment_vm.talos : k => v.id }
}

output "talosconfig_path" {
  description = "Path to saved talosconfig file"
  value       = local_sensitive_file.talosconfig.filename
}

output "kubeconfig_path" {
  description = "Path to saved kubeconfig file"
  value       = local_sensitive_file.kubeconfig.filename
}
