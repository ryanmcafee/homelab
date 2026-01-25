/**
 * UniFi Gateway Module
 *
 * Provisions BGP configuration on the UniFi gateway for MetalLB integration.
 * Uses FRRouting configuration syntax for BGP peer setup.
 */

terraform {
  required_version = ">= 1.7.0"
}

locals {
  # Generate FRRouting BGP configuration
  bgp_config = templatefile("${path.module}/templates/frr-bgp.conf.tftpl", {
    local_as             = var.bgp_local_as
    router_id            = var.bgp_router_id
    neighbors            = var.bgp_neighbors
    networks             = var.bgp_networks
    log_neighbor_changes = var.bgp_log_neighbor_changes
  })
}

resource "unifi_bgp" "this" {
  count = var.bgp_enabled ? 1 : 0

  description      = var.bgp_description
  enabled          = true
  site             = var.site
  config           = local.bgp_config
  upload_file_name = "frr-bgp-${var.bgp_local_as}.conf"
}
