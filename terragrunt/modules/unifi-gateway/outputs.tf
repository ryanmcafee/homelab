output "bgp_id" {
  description = "The ID of the UniFi BGP configuration"
  value       = var.bgp_enabled ? unifi_bgp.this[0].id : null
}

output "bgp_config" {
  description = "The generated FRRouting BGP configuration"
  value       = var.bgp_enabled ? local.bgp_config : null
  sensitive   = true
}

output "bgp_enabled" {
  description = "Whether BGP is enabled"
  value       = var.bgp_enabled
}
