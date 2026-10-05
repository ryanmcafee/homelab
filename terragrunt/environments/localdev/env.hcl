# Local Development Environment Configuration
# Uses Kind cluster for local development and testing

locals {
  # localdev is the environment a fork runs first, so it resolves from the
  # ConfigSet exactly like homelab does — it used to inherit base_fqdn from the
  # root terragrunt.hcl, which meant a fork that parameterised only
  # environments/homelab/env.hcl still built localdev against the maintainer's
  # domain. configuration/environments/localdev.yaml is committed, so this
  # export needs no secrets:
  #   task config:export:format ENV=localdev FORMAT=json
  config = jsondecode(file("${get_repo_root()}/configuration/resolved.localdev.json")).values

  # Environment-specific overrides
  environment = "localdev"

  # Kind cluster configuration
  cluster_name     = local.config.CLUSTER_NAME
  cluster_endpoint = local.config.CP1_IP

  # Base FQDN. The root terragrunt.hcl no longer supplies one, so localdev must
  # resolve its own or the modules' required variable stays unset.
  base_fqdn = local.config.DOMAIN

  # Kind's own pod network, not the operator's LAN: Kind assigns it and it is
  # identical in every fork, so it is not a ConfigSet value.
  vlan_id     = null
  subnet      = "10.244.0.0/16"
  gateway     = cidrhost(local.subnet, 1)
  dns_servers = [local.config.DNS_SERVER_IP]

  # Git repository
  repo_url        = local.config.GITOPS_REPO_URL
  target_revision = "HEAD"

  # Resource limits (smaller for local dev)
  kind_worker_count = 2
}
