# Development - GitOps Bootstrap
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

dependency "talos_cluster" {
  config_path = "../talos-cluster"
}

dependency "truenas" {
  config_path = "../truenas"
}

# Configure Kubernetes providers using Talos cluster outputs
generate "provider_k8s" {
  path      = "provider_k8s.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "kubernetes" {
  host                   = "${dependency.talos_cluster.outputs.cluster_endpoint}"
  client_certificate     = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["users"][0]["user"]["client-certificate-data"])
  client_key             = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["users"][0]["user"]["client-key-data"])
  cluster_ca_certificate = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["clusters"][0]["cluster"]["certificate-authority-data"])
}

provider "helm" {
  kubernetes {
    host                   = "${dependency.talos_cluster.outputs.cluster_endpoint}"
    client_certificate     = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["users"][0]["user"]["client-certificate-data"])
    client_key             = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["users"][0]["user"]["client-key-data"])
    cluster_ca_certificate = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["clusters"][0]["cluster"]["certificate-authority-data"])
  }
}

provider "kubectl" {
  host                   = "${dependency.talos_cluster.outputs.cluster_endpoint}"
  client_certificate     = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["users"][0]["user"]["client-certificate-data"])
  client_key             = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["users"][0]["user"]["client-key-data"])
  cluster_ca_certificate = base64decode(yamldecode(dependency.talos_cluster.outputs.kubeconfig)["clusters"][0]["cluster"]["certificate-authority-data"])
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
  admin_enabled    = true

  # Ingress (disabled for dev, use port-forward)
  server_ingress_enabled = false

  # GitOps Bridge metadata
  custom_metadata = {
    environment         = include.env.locals.environment
    cluster_type        = "talos"
    truenas_ip          = include.env.locals.truenas_ip
    truenas_nfs_path    = include.env.locals.truenas_nfs_path
    metallb_ip_range    = "${include.env.locals.metallb_ip_start}-${include.env.locals.metallb_ip_end}"
    metallb_enabled     = tostring(include.env.locals.metallb_enabled)
    bgp_asn_k8s         = tostring(include.env.locals.bgp_asn_k8s)
    bgp_asn_unifi       = tostring(include.env.locals.bgp_asn_unifi)
    bgp_peer_ip         = include.env.locals.bgp_peer_ip
    cert_manager_email  = "admin@${include.env.locals.base_fqdn}"
  }

  # Enable auto-sync
  auto_sync_enabled  = true
  auto_prune_enabled = true
  self_heal_enabled  = true

  wait_for_argocd = true

  # 1Password credentials (read from environment variables)
  onepassword_credentials_json      = get_env("TF_VAR_onepassword_credentials_json", "")
  onepassword_connect_host          = get_env("OP_CONNECT_HOST", "")
  onepassword_connect_token         = get_env("OP_CONNECT_TOKEN", "")
  onepassword_service_account_token = get_env("OP_SERVICE_ACCOUNT_TOKEN", "")
}
