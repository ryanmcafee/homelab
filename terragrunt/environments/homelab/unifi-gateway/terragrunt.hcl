# Homelab - UniFi Gateway Configuration
# Provisions BGP peering between UniFi and Kubernetes (MetalLB)

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
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
  bgp_description = "MetalLB BGP Peering - Homelab K8s Cluster"
  bgp_local_as    = include.env.locals.bgp_asn_unifi
  bgp_router_id   = include.env.locals.gateway

  # Peer with all Kubernetes nodes (MetalLB speakers)
  bgp_neighbors = [
    for name, node in merge(
      include.env.locals.control_plane_nodes,
      include.env.locals.worker_nodes
    ) : {
      address     = node.ip
      remote_as   = include.env.locals.bgp_asn_k8s
      description = "K8s ${name}"
      password    = null
    }
  ]

  # No networks to advertise - MetalLB advertises LoadBalancer IPs
  bgp_networks = []

  # Site configuration
  site = include.env.locals.unifi_site
}
