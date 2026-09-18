# Local Development Environment Configuration
# Uses Kind cluster for local development and testing

locals {

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

  # Git repository
  repo_url        = "https://github.com/ryanmcafee/homelab"
  target_revision = "HEAD"

  # Resource limits (smaller for local dev)
  kind_worker_count = 2
}
