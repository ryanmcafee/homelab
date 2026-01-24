/**
 * Proxmox Cluster DNS Module
 *
 * Provisions DNS records for Proxmox cluster endpoints via UniFi controller.
 */

terraform {
  required_version = ">= 1.7.0"
}

resource "unifi_dns_record" "this" {
  for_each = { for entry in var.dns_entries : entry.fqdn => entry }

  name        = each.value.fqdn
  record_type = each.value.type
  value       = each.value.host
  enabled     = true
  ttl         = var.dns_ttl
  port        = 0 # Required to avoid provider inconsistency bug

  lifecycle {
    ignore_changes = [port]
  }
}
