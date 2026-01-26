output "cluster_name" {
  description = "Name of the Kubernetes cluster"
  value       = var.cluster_name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint"
  value       = "https://${var.cluster_endpoint}:6443"
}

output "vip_endpoint" {
  description = "VIP endpoint for the cluster"
  value       = var.vip_endpoint
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
  value = merge(
    { for k, v in proxmox_virtual_environment_vm.controlplane : k => v.vm_id },
    { for k, v in proxmox_virtual_environment_vm.worker : k => v.vm_id }
  )
}

# Outputs for talos-cluster-config module
output "client_configuration" {
  description = "Talos client configuration for machine API access"
  value       = talos_machine_secrets.this.client_configuration
  sensitive   = true
}

output "talos_config" {
  description = "Full Talos client configuration YAML"
  value       = data.talos_client_configuration.this.talos_config
  sensitive   = true
}

output "controlplane_machine_configs" {
  description = "Map of control plane node names to their machine configurations (base64 encoded to avoid interpolation issues)"
  value       = { for k, v in data.talos_machine_configuration.controlplane : k => base64encode(v.machine_configuration) }
  sensitive   = true
}

output "worker_machine_configs" {
  description = "Map of worker node names to their machine configurations (base64 encoded to avoid interpolation issues)"
  value       = { for k, v in data.talos_machine_configuration.worker : k => base64encode(v.machine_configuration) }
  sensitive   = true
}

output "bootstrap_trigger" {
  description = "Trigger value that changes when cluster needs re-bootstrapping (machine secrets ID)"
  value       = talos_machine_secrets.this.id
}
