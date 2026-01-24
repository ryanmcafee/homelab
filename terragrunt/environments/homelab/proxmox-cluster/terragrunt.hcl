# Homelab - Proxmox Cluster DNS
# Provisions DNS records for Proxmox cluster endpoints

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//proxmox-cluster"
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
  dns_entries = [
    { fqdn = "proxmox.home.lab", type = "A", host = include.env.locals.proxmox_host },
    { fqdn = "proxmox.${include.env.locals.base_fqdn}", type = "A", host = include.env.locals.proxmox_host }
  ]
}
