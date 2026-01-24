# Homelab - Talos Cluster Configuration
# Applies Talos machine configurations and bootstraps the cluster.
# Separated from talos-cluster to allow infrastructure planning when cluster is offline.

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//talos-cluster-config"
}

dependency "talos_cluster" {
  config_path = "../talos-cluster"

  # Use mock outputs for validate when state doesn't exist
  mock_outputs_allowed_terraform_commands = ["validate"]

  mock_outputs = {
    client_configuration = {
      ca_certificate     = "mock-ca"
      client_certificate = "mock-cert"
      client_key         = "mock-key"
    }
    talos_config                 = "mock-talos-config"
    controlplane_machine_configs = {}
    worker_machine_configs       = {}
    bootstrap_trigger            = "mock-trigger"
  }
}

# Configure 1Password provider
# Use only service_account_token, override Connect env vars with empty strings
generate "provider_onepassword" {
  path      = "provider_onepassword.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
variable "onepassword_service_account_token" {
  description = "1Password service account token"
  type        = string
  sensitive   = true
  default     = ""
}

provider "onepassword" {
  service_account_token = var.onepassword_service_account_token
  # Override Connect env vars to disable Connect authentication
  url   = ""
  token = ""
}
EOF
}

# Configure UniFi provider for DNS records
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
  # Pass through from talos-cluster module
  client_configuration         = dependency.talos_cluster.outputs.client_configuration
  talos_config                 = dependency.talos_cluster.outputs.talos_config
  controlplane_machine_configs = dependency.talos_cluster.outputs.controlplane_machine_configs
  worker_machine_configs       = dependency.talos_cluster.outputs.worker_machine_configs
  bootstrap_trigger            = dependency.talos_cluster.outputs.bootstrap_trigger

  # Node configurations from env.hcl
  control_plane_nodes = include.env.locals.control_plane_nodes
  worker_nodes        = include.env.locals.worker_nodes

  # Cluster configuration
  cluster_name      = include.env.locals.cluster_name
  cluster_endpoint  = include.env.locals.cluster_endpoint
  bootstrap_cluster = true

  # 1Password vault for storing kubeconfig/talosconfig
  # Set via environment variable TF_VAR_onepassword_vault_id or leave empty to skip
  onepassword_vault_id = get_env("TF_VAR_onepassword_vault_id", "")

  # DNS records for Kubernetes API
  dns_entries = [
    { fqdn = "k8s.home.lab", type = "A", host = include.env.locals.cluster_endpoint },
    { fqdn = "k8s.${include.env.locals.base_fqdn}", type = "A", host = include.env.locals.cluster_endpoint }
  ]
}
