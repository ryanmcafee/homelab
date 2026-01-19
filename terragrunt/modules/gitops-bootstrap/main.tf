/**
 * GitOps Bootstrap Module
 *
 * Implements the GitOps Bridge pattern to bootstrap ArgoCD and pass infrastructure
 * metadata from Terragrunt to Kubernetes/ArgoCD for application deployment.
 *
 * Reference: https://github.com/gitops-bridge-dev/gitops-bridge
 */

terraform {
  required_version = ">= 1.7.0"
}

# Create ArgoCD namespace
resource "kubernetes_namespace" "argocd" {
  metadata {
    name = var.argocd_namespace
    labels = {
      "app.kubernetes.io/name"    = "argocd"
      "app.kubernetes.io/part-of" = "argocd"
    }
  }
}

# Install ArgoCD via Helm
resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  namespace  = kubernetes_namespace.argocd.metadata[0].name
  version    = var.argocd_version

  values = [
    templatefile("${path.module}/templates/argocd-values.yaml.tpl", {
      admin_enabled         = var.admin_enabled
      server_ingress_enabled = var.server_ingress_enabled
      server_host           = var.server_host
      dex_enabled           = var.dex_enabled
      notifications_enabled = var.notifications_enabled
    })
  ]

  # Merge with custom values
  dynamic "set" {
    for_each = var.argocd_helm_values
    content {
      name  = set.key
      value = set.value
    }
  }

  depends_on = [kubernetes_namespace.argocd]
}

# GitOps Bridge: Pass metadata from Terragrunt to ArgoCD
resource "kubernetes_config_map" "gitops_metadata" {
  metadata {
    name      = "gitops-metadata"
    namespace = kubernetes_namespace.argocd.metadata[0].name
    labels = {
      "app.kubernetes.io/part-of" = "gitops-bridge"
    }
  }

  data = merge(
    {
      cluster_name     = var.cluster_name
      environment      = var.environment
      base_fqdn        = var.base_fqdn
      repo_url         = var.repo_url
      target_revision  = var.target_revision
    },
    var.custom_metadata
  )

  depends_on = [kubernetes_namespace.argocd]
}

# GitOps Bridge: Store sensitive metadata
resource "kubernetes_secret" "gitops_secrets" {
  count = length(var.gitops_secrets) > 0 ? 1 : 0

  metadata {
    name      = "gitops-secrets"
    namespace = kubernetes_namespace.argocd.metadata[0].name
    labels = {
      "app.kubernetes.io/part-of" = "gitops-bridge"
    }
  }

  data = var.gitops_secrets

  depends_on = [kubernetes_namespace.argocd]
}

# Bootstrap Application - points to charts/gitops (App of Apps pattern)
resource "kubectl_manifest" "bootstrap_app" {
  depends_on = [helm_release.argocd]

  yaml_body = templatefile("${path.module}/templates/bootstrap-app.yaml.tpl", {
    app_name        = "gitops"
    namespace       = kubernetes_namespace.argocd.metadata[0].name
    repo_url        = var.repo_url
    target_revision = var.target_revision
    path            = var.gitops_chart_path
    environment     = var.environment
    auto_sync       = var.auto_sync_enabled
    auto_prune      = var.auto_prune_enabled
    self_heal       = var.self_heal_enabled
  })
}

# Wait for ArgoCD to be ready
resource "null_resource" "wait_for_argocd" {
  count = var.wait_for_argocd ? 1 : 0

  depends_on = [helm_release.argocd]

  provisioner "local-exec" {
    command = <<-EOF
      kubectl wait --for=condition=available deployment/argocd-server \
        -n ${kubernetes_namespace.argocd.metadata[0].name} \
        --timeout=300s
      kubectl wait --for=condition=available deployment/argocd-repo-server \
        -n ${kubernetes_namespace.argocd.metadata[0].name} \
        --timeout=300s
      kubectl wait --for=condition=available deployment/argocd-application-controller \
        -n ${kubernetes_namespace.argocd.metadata[0].name} \
        --timeout=300s
    EOF
  }
}

# Retrieve ArgoCD admin password
data "kubernetes_secret" "argocd_admin" {
  depends_on = [helm_release.argocd]

  metadata {
    name      = "argocd-initial-admin-secret"
    namespace = kubernetes_namespace.argocd.metadata[0].name
  }
}
