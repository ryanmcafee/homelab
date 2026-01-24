# Local Development - GitOps Bootstrap
# Bootstraps ArgoCD in local Kind cluster

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

dependency "kind_cluster" {
  config_path = "../kind-cluster"
}

# Configure Kubernetes provider to use Kind cluster
generate "provider_k8s" {
  path      = "provider_k8s.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "kubernetes" {
  host                   = "${dependency.kind_cluster.outputs.endpoint}"
  client_certificate     = base64decode("${dependency.kind_cluster.outputs.client_certificate}")
  client_key             = base64decode("${dependency.kind_cluster.outputs.client_key}")
  cluster_ca_certificate = base64decode("${dependency.kind_cluster.outputs.cluster_ca_certificate}")
}

provider "helm" {
  kubernetes = {
    host                   = "${dependency.kind_cluster.outputs.endpoint}"
    client_certificate     = base64decode("${dependency.kind_cluster.outputs.client_certificate}")
    client_key             = base64decode("${dependency.kind_cluster.outputs.client_key}")
    cluster_ca_certificate = base64decode("${dependency.kind_cluster.outputs.cluster_ca_certificate}")
  }
}

provider "kubectl" {
  host                   = "${dependency.kind_cluster.outputs.endpoint}"
  client_certificate     = base64decode("${dependency.kind_cluster.outputs.client_certificate}")
  client_key             = base64decode("${dependency.kind_cluster.outputs.client_key}")
  cluster_ca_certificate = base64decode("${dependency.kind_cluster.outputs.cluster_ca_certificate}")
  load_config_file       = false
}
EOF
}

inputs = {
  cluster_name = include.env.locals.cluster_name
  environment  = include.env.locals.environment
  base_fqdn    = "local"

  # Git repository
  repo_url        = include.env.locals.repo_url
  target_revision = include.env.locals.target_revision

  # ArgoCD configuration
  argocd_namespace = "argocd"
  admin_enabled    = true

  # No ingress for local dev (use port-forward)
  server_ingress_enabled = false

  # Local dev metadata
  custom_metadata = {
    environment     = "localdev"
    cluster_type    = "kind"
    storage_class   = "local-path"
    metallb_enabled = "false"
  }

  # Enable auto-sync
  auto_sync_enabled  = true
  auto_prune_enabled = true
  self_heal_enabled  = true
}
