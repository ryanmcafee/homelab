# Local Development Environment Configuration
# Uses Kind cluster for local development and testing

locals {
  # Inherit base configuration
  base_config = read_terragrunt_config(find_in_parent_folders("_env/env.hcl"))

  # Environment-specific overrides
  environment = "localdev"

  # Kind cluster configuration
  cluster_name     = "homelab-local"
  cluster_endpoint = "127.0.0.1"

  # Network configuration (local only)
  vlan_id     = null
  subnet      = "10.244.0.0/16"
  gateway     = "10.244.0.1"
  dns_servers = ["8.8.8.8"]

  # No MetalLB in local dev (use NodePort or LoadBalancer with kind)
  metallb_enabled = false

  # Kubernetes configuration
  kubernetes_version = "v1.29.0"

  # Git repository
  repo_url        = "https://github.com/ryanmcafee/homelab"
  target_revision = "HEAD"

  # Resource limits (smaller for local dev)
  kind_worker_count = 2
}
