/**
 * Talos Cluster Config Module
 *
 * Applies Talos machine configurations to running nodes and bootstraps the cluster.
 * Separated from talos-cluster module to allow infrastructure planning when cluster is offline.
 *
 * This module requires the Talos nodes to be running and reachable.
 */

locals {
  # Sorted control plane node keys for stable ordering
  # This ensures bootstrap always runs on the same node (first alphabetically)
  controlplane_keys = sort(keys(var.control_plane_nodes))

  # First control plane node for bootstrap operations
  bootstrap_node_key = local.controlplane_keys[0]
  bootstrap_node_ip  = var.control_plane_nodes[local.bootstrap_node_key].ip

  # Transform kubeconfig to use the VIP endpoint if vip_endpoint is set
  # This ensures HA by routing through the VIP instead of a single node
  kubeconfig_raw    = talos_cluster_kubeconfig.this.kubeconfig_raw
  kubeconfig_parsed = yamldecode(local.kubeconfig_raw)

  # Build the corrected kubeconfig with VIP endpoint
  kubeconfig_with_vip = var.vip_endpoint != "" ? yamlencode({
    apiVersion = local.kubeconfig_parsed.apiVersion
    kind       = local.kubeconfig_parsed.kind
    clusters = [
      for cluster in local.kubeconfig_parsed.clusters : {
        name = cluster.name
        cluster = merge(cluster.cluster, {
          server = "https://${var.vip_endpoint}:6443"
        })
      }
    ]
    contexts        = local.kubeconfig_parsed.contexts
    current-context = local.kubeconfig_parsed["current-context"]
    users           = local.kubeconfig_parsed.users
  }) : local.kubeconfig_raw
}

# Trigger resource that tracks when bootstrap should re-run
# IMPORTANT: Only trigger on machine_secrets changes (new cluster creation)
# Config changes (DNS, patches, etc.) should NOT trigger re-bootstrap
# as the cluster just needs configs re-applied, not a fresh bootstrap
resource "terraform_data" "bootstrap_trigger" {
  count = var.bootstrap_cluster ? 1 : 0
  input = var.bootstrap_trigger
}

# Apply Talos configurations to control plane nodes
resource "talos_machine_configuration_apply" "controlplane" {
  for_each = var.control_plane_nodes

  client_configuration        = var.client_configuration
  machine_configuration_input = base64decode(var.controlplane_machine_configs[each.key])
  node                        = each.value.ip
  endpoint                    = each.value.ip
}

# Capture the bootstrap node's configuration apply resource for trigger purposes.
# This is needed because replace_triggered_by cannot use local values as indices.
resource "terraform_data" "bootstrap_node_trigger" {
  triggers_replace = [
    talos_machine_configuration_apply.controlplane[local.bootstrap_node_key].id
  ]
}

# Wait for node to be ready before bootstrap
# This gives the node time to fully initialize after configuration is applied
resource "time_sleep" "wait_before_bootstrap" {
  depends_on = [terraform_data.bootstrap_node_trigger]

  create_duration = "15m"
}

# Bootstrap the cluster on the first control plane node (sorted alphabetically)
# This executes the equivalent of `talosctl bootstrap` against the first CP node
# to initialize etcd and start the Kubernetes control plane
resource "talos_machine_bootstrap" "this" {
  count = var.bootstrap_cluster ? 1 : 0

  depends_on = [
    talos_machine_configuration_apply.controlplane,
    # There's a bug in the Talos provider where the bootstrap command fails if the node is not ready.
    # This is a workaround to wait for the node to be ready before running the bootstrap command.
    # https://github.com/siderolabs/terraform-provider-talos/issues/265
    # In the future, we may be able to instead wait on the https://registry.terraform.io/providers/siderolabs/talos/latest/docs/data-sources/cluster_health, but it will need to be extended to support the boot/apply use case where a cni is used.
    time_sleep.wait_before_bootstrap,
  ]

  client_configuration = var.client_configuration
  node                 = local.bootstrap_node_ip
  endpoint             = local.bootstrap_node_ip

  # Only re-run bootstrap if the first control plane node is tainted/replaced.
  # This avoids re-bootstrapping on routine config changes.
  lifecycle {
    replace_triggered_by = [
      terraform_data.bootstrap_node_trigger,
    ]
  }

  timeouts = {
    create = "5m"
  }
}

# Wait for k8s api to be healthy after bootstrap
# This ensures etcd is running and the control plane is ready
# data "talos_cluster_health" "controlplane" {
#   count = var.bootstrap_cluster ? 1 : 0

#   depends_on = [talos_machine_bootstrap.this]

#   client_configuration = var.client_configuration
#   control_plane_nodes  = [for k, v in var.control_plane_nodes : v.ip]
#   endpoints            = [for k, v in var.control_plane_nodes : v.ip]

#   timeouts = {
#     read = "5m"
#   }
# }

# Apply Talos configurations to worker nodes
resource "talos_machine_configuration_apply" "worker" {
  depends_on = [
    talos_machine_configuration_apply.controlplane,
    talos_machine_bootstrap.this,
    # data.talos_cluster_health.controlplane,
  ]
  for_each = var.worker_nodes

  client_configuration        = var.client_configuration
  machine_configuration_input = base64decode(var.worker_machine_configs[each.key])
  node                        = each.value.ip
  endpoint                    = each.value.ip
}

# Generate kubeconfig from the bootstrap node
resource "talos_cluster_kubeconfig" "this" {
  # depends_on = [data.talos_cluster_health.controlplane]
  depends_on = [talos_machine_bootstrap.this, ]

  client_configuration = var.client_configuration
  node                 = local.bootstrap_node_ip
  endpoint             = local.bootstrap_node_ip
}

# Save talosconfig to home directory
resource "local_sensitive_file" "talosconfig" {
  content  = var.talos_config
  filename = pathexpand(var.talosconfig_path)
}

# Ensure ~/.kube directory exists
resource "terraform_data" "kube_dir" {
  provisioner "local-exec" {
    command = "mkdir -p ${dirname(pathexpand(var.kubeconfig_path))}"
  }
}

# Save kubeconfig to ~/.kube/config
# Uses the VIP-corrected kubeconfig if cluster_endpoint is set
resource "local_sensitive_file" "kubeconfig" {
  depends_on = [terraform_data.kube_dir]

  content  = local.kubeconfig_with_vip
  filename = pathexpand(var.kubeconfig_path)
}

# Look up the 1Password vault to get a consistent ID reference
# This works around the provider bug where vault IDs are concealed during plan
data "onepassword_vault" "this" {
  count = var.onepassword_vault_id != "" ? 1 : 0
  uuid  = var.onepassword_vault_id
}

# Store kubeconfig in 1Password
resource "onepassword_item" "kubeconfig" {
  count = var.onepassword_vault_id != "" ? 1 : 0

  vault = data.onepassword_vault.this[0].uuid
  title = "${var.cluster_name}-kubeconfig"

  category = "secure_note"

  section {
    label = "Kubernetes Configuration"

    field {
      label = "kubeconfig"
      type  = "CONCEALED"
      value = local.kubeconfig_with_vip
    }

    field {
      label = "cluster_endpoint"
      type  = "STRING"
      value = var.vip_endpoint != "" ? "https://${var.vip_endpoint}:6443" : yamldecode(talos_cluster_kubeconfig.this.kubeconfig_raw)["clusters"][0]["cluster"]["server"]
    }

    field {
      label = "cluster_name"
      type  = "STRING"
      value = var.cluster_name
    }
  }

  tags = ["kubernetes", "kubeconfig", var.cluster_name]

  lifecycle {
    ignore_changes = [vault]
  }
}

# Store talosconfig in 1Password
resource "onepassword_item" "talosconfig" {
  count = var.onepassword_vault_id != "" ? 1 : 0

  vault = data.onepassword_vault.this[0].uuid
  title = "${var.cluster_name}-talosconfig"

  category = "secure_note"

  section {
    label = "Talos Configuration"

    field {
      label = "talosconfig"
      type  = "CONCEALED"
      value = var.talos_config
    }

    field {
      label = "cluster_name"
      type  = "STRING"
      value = var.cluster_name
    }
  }

  tags = ["talos", "talosconfig", var.cluster_name]

  lifecycle {
    ignore_changes = [vault]
  }
}

# DNS Records for Kubernetes API
resource "unifi_dns_record" "this" {
  for_each = { for entry in var.dns_entries : entry.fqdn => entry }

  name        = each.value.fqdn
  record_type = each.value.type
  value       = each.value.host
  enabled     = true
  ttl         = var.dns_ttl
  port        = 0 # Required to avoid provider inconsistency bug

  lifecycle {
    ignore_changes = [port]
  }
}
