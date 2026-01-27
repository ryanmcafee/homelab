# Homelab - GitOps Bootstrap
# Bootstraps ArgoCD with GitOps Bridge pattern

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//gitops-bootstrap"
}

dependency "talos_cluster_config" {
  config_path = "../talos-cluster-config"

  # Mock outputs for destroy operations or when cluster doesn't exist yet
  # Uses valid self-signed certificates to pass provider validation
  mock_outputs = {
    cluster_endpoint = "https://127.0.0.1:6443"
    kubeconfig_path  = "/tmp/mock-kubeconfig"
    # Valid self-signed CA certificate
    cluster_ca_certificate = <<-EOT
-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUOn3bmAtbtoYAVXR5RxedgFlQOxIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDEyMjAwMzI0OVoXDTI3MDEy
MjAwMzI0OVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApn2d8grfxk7+HAAdgcReMXtts1KzuC75RtuRCRWHh0af
0G0KjJa/aZwiZ4LQ1j7y0CzCVxZ/7CW/RscQtcdp+lY1NOwbGFUxXV+EtFE6o3XR
EKLwf842Z2U8D1Kdi0esLe27iTH1UhxNor17+A/++81kwUU+bTqm1fCYwDjLApFD
t1atIKP39TE0+mOR61Lpv9oyvQiY0STIfIPmle3CfB/UbYFhdkNWlvOMR7RsyOPs
qk+9xh41SInr+LP6F72PzdfiQHAiRvZ8Z5kGYH4CZONx7cMUfd7U82AL06QSp2fM
uuAwa3QQVyBKb075NeOaYk4HuZDLjs2kRXA1/KijIQIDAQABo1MwUTAdBgNVHQ4E
FgQULzQ/kLWgfI1o0OgXdv2MohIDxm0wHwYDVR0jBBgwFoAULzQ/kLWgfI1o0OgX
dv2MohIDxm0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAgvqX
gM2gCYyUY87lJzsxQAltwqxZ+jOII1VrqrGju3g/DQ39Dw2THh1BPip6+Xhdxf9n
6YKFGtZiSUY4Wt7iE4cWUbd6KY0uyalvwgTIu3BHA2Ncmhh1UIhCgd824DZwgkqd
FgKiUOWMo/D+JrRKDGEwHdMlExGd4XSgk6MdOWAZnfdXZ1oA6yB/9LDKaTNFhMk/
yweWg4UkbzK1KAqTlngJnfxB2jvEjIM6Q6IExgwZgajgtdCGnwZZlvVs4VlKap54
3J/bqe5gba3KE+BIHWF5LWViBeligncMvzb3MmH5D0h88NTfkNwf1qFlTt0IlQuP
5oUz8+YmxbRLRs/6Hw==
-----END CERTIFICATE-----
EOT
    # Valid self-signed client certificate
    client_certificate = <<-EOT
-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUOn3bmAtbtoYAVXR5RxedgFlQOxIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDEyMjAwMzI0OVoXDTI3MDEy
MjAwMzI0OVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApn2d8grfxk7+HAAdgcReMXtts1KzuC75RtuRCRWHh0af
0G0KjJa/aZwiZ4LQ1j7y0CzCVxZ/7CW/RscQtcdp+lY1NOwbGFUxXV+EtFE6o3XR
EKLwf842Z2U8D1Kdi0esLe27iTH1UhxNor17+A/++81kwUU+bTqm1fCYwDjLApFD
t1atIKP39TE0+mOR61Lpv9oyvQiY0STIfIPmle3CfB/UbYFhdkNWlvOMR7RsyOPs
qk+9xh41SInr+LP6F72PzdfiQHAiRvZ8Z5kGYH4CZONx7cMUfd7U82AL06QSp2fM
uuAwa3QQVyBKb075NeOaYk4HuZDLjs2kRXA1/KijIQIDAQABo1MwUTAdBgNVHQ4E
FgQULzQ/kLWgfI1o0OgXdv2MohIDxm0wHwYDVR0jBBgwFoAULzQ/kLWgfI1o0OgX
dv2MohIDxm0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAgvqX
gM2gCYyUY87lJzsxQAltwqxZ+jOII1VrqrGju3g/DQ39Dw2THh1BPip6+Xhdxf9n
6YKFGtZiSUY4Wt7iE4cWUbd6KY0uyalvwgTIu3BHA2Ncmhh1UIhCgd824DZwgkqd
FgKiUOWMo/D+JrRKDGEwHdMlExGd4XSgk6MdOWAZnfdXZ1oA6yB/9LDKaTNFhMk/
yweWg4UkbzK1KAqTlngJnfxB2jvEjIM6Q6IExgwZgajgtdCGnwZZlvVs4VlKap54
3J/bqe5gba3KE+BIHWF5LWViBeligncMvzb3MmH5D0h88NTfkNwf1qFlTt0IlQuP
5oUz8+YmxbRLRs/6Hw==
-----END CERTIFICATE-----
EOT
    # Mock client key placeholder (not a real key - used only for terragrunt mock outputs)
    # The actual key is provided by the talos-cluster-config dependency at runtime
    client_key = "MOCK_KEY_PLACEHOLDER"
    kubeconfig = ""
  }
  mock_outputs_allowed_terraform_commands = ["destroy", "validate", "plan"]
  mock_outputs_merge_strategy_with_state  = "shallow"
}

dependency "truenas" {
  config_path = "../truenas"
}

# Configure Kubernetes providers using Talos cluster outputs
# Uses local variables to properly handle multi-line PEM certificates
generate "provider_k8s" {
  path      = "provider_k8s.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
locals {
  cluster_endpoint       = "${dependency.talos_cluster_config.outputs.cluster_endpoint}"
  client_certificate     = <<-CERT
${dependency.talos_cluster_config.outputs.client_certificate}
CERT
  client_key             = <<-KEY
${dependency.talos_cluster_config.outputs.client_key}
KEY
  cluster_ca_certificate = <<-CA
${dependency.talos_cluster_config.outputs.cluster_ca_certificate}
CA
}

provider "kubernetes" {
  host                   = local.cluster_endpoint
  client_certificate     = local.client_certificate
  client_key             = local.client_key
  cluster_ca_certificate = local.cluster_ca_certificate
}

provider "helm" {
  kubernetes = {
    host                   = local.cluster_endpoint
    client_certificate     = local.client_certificate
    client_key             = local.client_key
    cluster_ca_certificate = local.cluster_ca_certificate
  }
}

provider "kubectl" {
  host                   = local.cluster_endpoint
  client_certificate     = local.client_certificate
  client_key             = local.client_key
  cluster_ca_certificate = local.cluster_ca_certificate
  load_config_file       = false
}
EOF
}

inputs = {
  cluster_name = include.env.locals.cluster_name
  environment  = include.env.locals.environment
  base_fqdn    = include.env.locals.base_fqdn

  # Git repository
  repo_url        = include.env.locals.repo_url
  target_revision = include.env.locals.target_revision

  # ArgoCD configuration
  argocd_namespace = "argocd"
  argocd_version   = "7.7.15" # Keep in sync with addons chart
  admin_enabled    = true

  # Ingress (enable for production access)
  server_ingress_enabled = true
  server_host            = "argocd.${include.env.locals.base_fqdn}"

  # GitOps Bridge metadata
  # These values are passed to ArgoCD applications via ConfigMap
  custom_metadata = {
    environment        = include.env.locals.environment
    cluster_type       = "talos"
    truenas_ip         = include.env.locals.truenas_ip
    truenas_nfs_path   = include.env.locals.truenas_nfs_path
    metallb_ip_range   = "${include.env.locals.metallb_ip_start}-${include.env.locals.metallb_ip_end}"
    metallb_enabled    = tostring(include.env.locals.metallb_enabled)
    bgp_asn_k8s        = tostring(include.env.locals.bgp_asn_k8s)
    bgp_asn_unifi      = tostring(include.env.locals.bgp_asn_unifi)
    bgp_peer_ip        = include.env.locals.bgp_peer_ip
    cert_manager_email = "admin@${include.env.locals.base_fqdn}"
  }

  # Enable auto-sync for GitOps
  auto_sync_enabled  = true
  auto_prune_enabled = true
  self_heal_enabled  = true

  wait_for_argocd = true

  # Kubeconfig path for kubectl commands in local-exec provisioner
  kubeconfig_path = dependency.talos_cluster_config.outputs.kubeconfig_path

  # SOPS age private key for decrypting secrets (stored in 1Password)
  # Retrieve with: op read "op://homelab/sops-age-key/private_key"
  sops_age_private_key = get_env("SOPS_AGE_KEY", "")
}
