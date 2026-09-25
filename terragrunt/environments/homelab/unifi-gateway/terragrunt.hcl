# Homelab - UniFi Gateway Configuration
# Provisions BGP peering between UniFi and Kubernetes (Cilium BGP control plane)
# and the syslog/NetFlow exports to the OpenTelemetry gateway collector

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

# configuration/ values; tf:plan:component and tf:apply:component export this file first.
locals {
  config = jsondecode(file("${get_repo_root()}/configuration/resolved.json")).values
}

terraform {
  source = "../../../modules//unifi-gateway"
}

# Configure UniFi provider
generate "provider_unifi" {
  path      = "provider_unifi.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "unifi" {
  api_url        = "${include.env.locals.unifi_api_url}"
  username       = "${include.env.locals.unifi_username}"
  password       = "${include.env.locals.unifi_password}"
  allow_insecure = ${include.env.locals.unifi_insecure}
  site           = "${include.env.locals.unifi_site}"
}
EOF
}

inputs = {
  # BGP Configuration
  bgp_enabled     = true
  bgp_description = "Cilium BGP Peering - Homelab K8s Cluster"
  bgp_local_as    = include.env.locals.bgp_asn_unifi
  bgp_router_id   = include.env.locals.gateway

  # Only the workers speak BGP (CiliumBGPClusterConfig homelab-bgp nodeSelector).
  bgp_neighbors = [
    for name, node in include.env.locals.worker_nodes : {
      address     = node.ip
      remote_as   = include.env.locals.bgp_asn_k8s
      description = "K8s ${name}"
      password    = null
    }
  ]

  # No networks to advertise - Cilium advertises the LoadBalancer IPs
  bgp_networks = []

  # UniFi syslog (SIEM) and NetFlow exports to the OpenTelemetry gateway collector
  telemetry_enabled      = local.config.LOGGING_ENABLED == "true"
  telemetry_collector_ip = local.config.OTEL_LB_IP
  unifi_setting_script   = "${get_repo_root()}/scripts/unifi-setting.ts"
  unifi_insecure         = include.env.locals.unifi_insecure

  # Site configuration
  site = include.env.locals.unifi_site
}
