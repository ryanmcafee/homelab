/**
 * UniFi Gateway Module
 *
 * Provisions BGP configuration on the UniFi gateway to peer with Cilium
 * (LB IPAM advertises the LoadBalancer IPs over BGP).
 * Uses FRRouting configuration syntax for BGP peer setup.
 *
 * Points the activity log (SIEM syslog) and NetFlow/IPFIX exports at the
 * OpenTelemetry gateway collector when telemetry_enabled is set.
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
    maximum_paths        = coalesce(var.bgp_maximum_paths, max(length(var.bgp_neighbors), 1))
  })

  netflow_setting = {
    enabled = true
    server  = var.telemetry_collector_ip
    port    = var.netflow_port
    version = 10
  }
}

resource "unifi_bgp" "this" {
  count = var.bgp_enabled ? 1 : 0

  description      = var.bgp_description
  enabled          = true
  site             = var.site
  config           = local.bgp_config
  upload_file_name = "frr-bgp-${var.bgp_local_as}.conf"
}

resource "unifi_setting" "syslog" {
  count = var.telemetry_enabled ? 1 : 0

  site = var.site

  syslog = {
    enabled                        = true
    ip                             = var.telemetry_collector_ip
    port                           = var.syslog_port
    log_all_contents               = true
    this_controller                = true
    this_controller_encrypted_only = true
    debug                          = false
    netconsole_enabled             = false
  }
}

# The provider has no NetFlow setting, so the controller API is called through scripts/unifi-setting.ts.
resource "terraform_data" "netflow" {
  count = var.telemetry_enabled ? 1 : 0

  triggers_replace = local.netflow_setting

  provisioner "local-exec" {
    interpreter = concat(
      ["bun", var.unifi_setting_script, "apply", "netflow", "--site", var.site],
      var.unifi_insecure ? ["--insecure"] : [],
      ["--data"],
    )
    command = jsonencode(local.netflow_setting)
  }
}
