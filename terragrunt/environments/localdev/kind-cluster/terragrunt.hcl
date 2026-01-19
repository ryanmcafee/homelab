# Local Development - Kind Cluster
# Creates a local Kubernetes cluster for development

include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}

terraform {
  source = "../../../modules//kind-cluster"
}

inputs = {
  cluster_name = include.env.locals.cluster_name
  worker_count = include.env.locals.kind_worker_count

  # Ingress configuration
  ingress_enabled    = true
  ingress_http_port  = 80
  ingress_https_port = 443

  # Install common addons
  install_local_path_provisioner = true
  install_metrics_server         = true

  # Wait for cluster to be ready
  wait_for_ready = true
}
