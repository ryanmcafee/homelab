/**
 * Kind Cluster Module
 *
 * Provisions a local Kubernetes cluster using Kind (Kubernetes in Docker).
 * Designed for rapid local development and testing of GitOps configurations.
 */

terraform {
  required_version = ">= 1.7.0"
}

# Create Kind cluster
resource "kind_cluster" "this" {
  name            = var.cluster_name
  wait_for_ready  = var.wait_for_ready
  kubeconfig_path = var.kubeconfig_path != "" ? var.kubeconfig_path : pathexpand("~/.kube/config")

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    # Networking configuration
    networking {
      api_server_address  = var.api_server_address
      api_server_port     = var.api_server_port
      pod_subnet          = var.pod_subnet
      service_subnet      = var.service_subnet
      disable_default_cni = var.disable_default_cni
    }

    # Control plane node
    node {
      role = "control-plane"

      # Port mappings for ingress
      dynamic "extra_port_mappings" {
        for_each = var.ingress_enabled ? [1] : []
        content {
          container_port = 80
          host_port      = var.ingress_http_port
          protocol       = "TCP"
        }
      }

      dynamic "extra_port_mappings" {
        for_each = var.ingress_enabled ? [1] : []
        content {
          container_port = 443
          host_port      = var.ingress_https_port
          protocol       = "TCP"
        }
      }

      # Node labels
      labels = merge(
        {
          "ingress-ready" = var.ingress_enabled ? "true" : "false"
        },
        var.control_plane_labels
      )

      # Extra mounts
      dynamic "extra_mounts" {
        for_each = var.extra_mounts
        content {
          host_path      = extra_mounts.value.host_path
          container_path = extra_mounts.value.container_path
          read_only      = try(extra_mounts.value.read_only, false)
        }
      }
    }

    # Worker nodes
    dynamic "node" {
      for_each = range(var.worker_count)
      content {
        role = "worker"

        # Worker labels
        labels = var.worker_labels

        # Extra mounts for workers
        dynamic "extra_mounts" {
          for_each = var.extra_mounts
          content {
            host_path      = extra_mounts.value.host_path
            container_path = extra_mounts.value.container_path
            read_only      = try(extra_mounts.value.read_only, false)
          }
        }
      }
    }

    # Runtime configuration
    dynamic "containerd_config_patches" {
      for_each = var.containerd_config_patches
      content {
        value = containerd_config_patches.value
      }
    }
  }
}

# Install local-path-provisioner for dynamic storage
resource "null_resource" "local_path_provisioner" {
  count = var.install_local_path_provisioner ? 1 : 0

  depends_on = [kind_cluster.this]

  provisioner "local-exec" {
    command = <<-EOF
      kubectl --kubeconfig=${kind_cluster.this.kubeconfig_path} apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml
      kubectl --kubeconfig=${kind_cluster.this.kubeconfig_path} patch storageclass local-path -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
    EOF
  }
}

# Install metrics-server for HPA support
resource "null_resource" "metrics_server" {
  count = var.install_metrics_server ? 1 : 0

  depends_on = [kind_cluster.this]

  provisioner "local-exec" {
    command = <<-EOF
      kubectl --kubeconfig=${kind_cluster.this.kubeconfig_path} apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
      kubectl --kubeconfig=${kind_cluster.this.kubeconfig_path} patch deployment metrics-server -n kube-system --type='json' -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--kubelet-insecure-tls"}]'
    EOF
  }
}

# Wait for cluster to be ready
resource "null_resource" "wait_for_cluster" {
  count = var.wait_for_ready ? 1 : 0

  depends_on = [
    kind_cluster.this,
    null_resource.local_path_provisioner,
    null_resource.metrics_server
  ]

  provisioner "local-exec" {
    command = <<-EOF
      echo "Waiting for cluster to be ready..."
      kubectl --kubeconfig=${kind_cluster.this.kubeconfig_path} wait --for=condition=ready node --all --timeout=300s
      echo "Cluster is ready!"
    EOF
  }
}
