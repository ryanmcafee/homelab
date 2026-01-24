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
resource "kubernetes_namespace_v1" "argocd" {
  metadata {
    name = var.argocd_namespace
    labels = {
      "app.kubernetes.io/name"    = "argocd"
      "app.kubernetes.io/part-of" = "argocd"
    }
  }
}

# Create 1Password Operator namespace (if credentials provided)
resource "kubernetes_namespace_v1" "onepassword_operator" {
  count = var.onepassword_credentials_json != "" ? 1 : 0

  metadata {
    name = "onepassword-operator"
    labels = {
      "app.kubernetes.io/name"       = "onepassword-operator"
      "app.kubernetes.io/managed-by" = "terraform"
      "app.kubernetes.io/part-of"    = "gitops-bootstrap"
    }
  }
}

# Create 1Password credentials secret
resource "kubernetes_secret_v1" "onepassword_credentials" {
  count = var.onepassword_credentials_json != "" ? 1 : 0

  metadata {
    name      = "onepassword-credentials"
    namespace = kubernetes_namespace_v1.onepassword_operator[0].metadata[0].name
    labels = {
      "app.kubernetes.io/name"       = "onepassword-credentials"
      "app.kubernetes.io/managed-by" = "terraform"
      "app.kubernetes.io/part-of"    = "gitops-bootstrap"
    }
  }

  data = {
    "1password-credentials.json" = var.onepassword_credentials_json
    "OP_CONNECT_HOST"            = var.onepassword_connect_host
    "OP_CONNECT_TOKEN"           = var.onepassword_connect_token
    "OP_SERVICE_ACCOUNT_TOKEN"   = var.onepassword_service_account_token
  }

  type = "Opaque"

  depends_on = [kubernetes_namespace_v1.onepassword_operator]
}

# Install ArgoCD via Helm
resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  namespace  = kubernetes_namespace_v1.argocd.metadata[0].name
  version    = var.argocd_version

  values = [
    templatefile("${path.module}/templates/argocd-values.yaml.tpl", {
      admin_enabled          = var.admin_enabled
      server_ingress_enabled = var.server_ingress_enabled
      server_host            = var.server_host
      dex_enabled            = var.dex_enabled
      notifications_enabled  = var.notifications_enabled
    })
  ]

  # Merge with custom values
  set = [for k, v in var.argocd_helm_values : { name = k, value = v }]

  depends_on = [kubernetes_namespace_v1.argocd]
}

# GitOps Bridge: Pass metadata from Terragrunt to ArgoCD
resource "kubernetes_config_map_v1" "gitops_metadata" {
  metadata {
    name      = "gitops-metadata"
    namespace = kubernetes_namespace_v1.argocd.metadata[0].name
    labels = {
      "app.kubernetes.io/part-of" = "gitops-bridge"
    }
  }

  data = merge(
    {
      cluster_name    = var.cluster_name
      environment     = var.environment
      base_fqdn       = var.base_fqdn
      repo_url        = var.repo_url
      target_revision = var.target_revision
    },
    var.custom_metadata
  )

  depends_on = [kubernetes_namespace_v1.argocd]
}

# GitOps Bridge: Store sensitive metadata
resource "kubernetes_secret_v1" "gitops_secrets" {
  count = length(var.gitops_secrets) > 0 ? 1 : 0

  metadata {
    name      = "gitops-secrets"
    namespace = kubernetes_namespace_v1.argocd.metadata[0].name
    labels = {
      "app.kubernetes.io/part-of" = "gitops-bridge"
    }
  }

  data = var.gitops_secrets

  depends_on = [kubernetes_namespace_v1.argocd]
}

# Bootstrap Application - points to charts/gitops (App of Apps pattern)
resource "kubectl_manifest" "bootstrap_app" {
  depends_on = [helm_release.argocd]

  yaml_body = templatefile("${path.module}/templates/bootstrap-app.yaml.tpl", {
    app_name        = "gitops"
    namespace       = kubernetes_namespace_v1.argocd.metadata[0].name
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
        -n ${kubernetes_namespace_v1.argocd.metadata[0].name} \
        --timeout=300s
      kubectl wait --for=condition=available deployment/argocd-repo-server \
        -n ${kubernetes_namespace_v1.argocd.metadata[0].name} \
        --timeout=300s
      kubectl rollout status statefulset/argocd-application-controller \
        -n ${kubernetes_namespace_v1.argocd.metadata[0].name} \
        --timeout=300s
    EOF

    environment = {
      KUBECONFIG = var.kubeconfig_path
    }
  }
}

# Retrieve ArgoCD admin password
data "kubernetes_secret_v1" "argocd_admin" {
  depends_on = [helm_release.argocd]

  metadata {
    name      = "argocd-initial-admin-secret"
    namespace = kubernetes_namespace_v1.argocd.metadata[0].name
  }
}
