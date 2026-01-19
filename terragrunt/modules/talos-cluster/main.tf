/**
 * Talos Cluster Module
 *
 * Provisions a complete Talos Linux Kubernetes cluster with:
 * - Control plane nodes (HA configuration)
 * - Worker nodes (with optional GPU passthrough)
 * - Machine configuration generation
 * - Cluster bootstrapping
 */

terraform {
  required_version = ">= 1.7.0"
}

locals {
  # Merge control plane and worker node configurations
  all_nodes = merge(
    { for k, v in var.control_plane_nodes : k => merge(v, { machine_type = "controlplane" }) },
    { for k, v in var.worker_nodes : k => merge(v, { machine_type = "worker" }) }
  )
}

# Generate Talos machine secrets
resource "talos_machine_secrets" "this" {
  talos_version = var.talos_version
}

# Generate Talos client configuration
data "talos_client_configuration" "this" {
  cluster_name         = var.cluster_name
  client_configuration = talos_machine_secrets.this.client_configuration
  endpoints            = [for k, v in var.control_plane_nodes : v.ip]
}

# Generate machine configurations for control plane
data "talos_machine_configuration" "controlplane" {
  cluster_name     = var.cluster_name
  cluster_endpoint = "https://${var.cluster_endpoint}:6443"
  machine_type     = "controlplane"
  machine_secrets  = talos_machine_secrets.this.machine_secrets
  talos_version    = var.talos_version

  kubernetes_version = var.kubernetes_version

  docs     = false
  examples = false

  config_patches = concat(
    var.common_config_patches,
    var.controlplane_config_patches,
    [
      yamlencode({
        cluster = {
          network = {
            cni = {
              name = "none"  # Cilium will be installed
            }
          }
          proxy = {
            disabled = true  # Cilium handles this
          }
          allowSchedulingOnControlPlanes = var.allow_scheduling_on_control_planes
        }
      })
    ]
  )
}

# Generate machine configurations for workers
data "talos_machine_configuration" "worker" {
  cluster_name     = var.cluster_name
  cluster_endpoint = "https://${var.cluster_endpoint}:6443"
  machine_type     = "worker"
  machine_secrets  = talos_machine_secrets.this.machine_secrets
  talos_version    = var.talos_version

  kubernetes_version = var.kubernetes_version

  docs     = false
  examples = false

  config_patches = concat(
    var.common_config_patches,
    var.worker_config_patches
  )
}

# Create Talos VMs in Proxmox
resource "proxmox_virtual_environment_vm" "talos" {
  for_each = local.all_nodes

  name        = each.key
  description = "Talos ${each.value.machine_type} node"
  node_name   = each.value.host_node
  pool_id     = var.pool_id
  tags        = concat(["talos", "kubernetes", each.value.machine_type], var.tags)

  started = var.started
  on_boot = var.on_boot

  cpu {
    cores = each.value.cores
    type  = var.cpu_type
    flags = var.cpu_flags
  }

  memory {
    dedicated = each.value.memory
  }

  # System disk for Talos (Talos will install to this)
  disk {
    datastore_id = var.datastore_id
    size         = each.value.disk_size
    interface    = "scsi0"
    iothread     = true
    ssd          = true
    discard      = "on"
  }

  # Boot from Talos ISO
  cdrom {
    enabled   = true
    file_id   = var.talos_image_id
    interface = "ide2"
  }

  # GPU passthrough (for workers with GPU enabled)
  dynamic "hostpci" {
    for_each = try(each.value.gpu, false) ? [1] : []
    content {
      device = "hostpci0"
      id     = var.gpu_pci_id
      pcie   = true
      rombar = true
      xvga   = false
    }
  }

  # Network device
  network_device {
    bridge  = var.network_bridge
  }

  # Boot order - boot from CDROM (Talos ISO)
  boot_order = ["ide2", "scsi0"]

  # QEMU agent
  agent {
    enabled = true
    timeout = "15m"
  }

  # VGA - virtio for better console output
  vga {
    type   = "virtio"
    memory = 16
  }

  # Machine type for better hardware support
  machine = "q35"

  # SCSI controller for disk
  scsi_hardware = "virtio-scsi-single"

  lifecycle {
    ignore_changes = [
      disk,
      cdrom,
    ]
  }
}

# Apply Talos configurations to nodes
resource "talos_machine_configuration_apply" "controlplane" {
  for_each = var.control_plane_nodes

  depends_on = [proxmox_virtual_environment_vm.talos]

  client_configuration        = talos_machine_secrets.this.client_configuration
  machine_configuration_input = data.talos_machine_configuration.controlplane.machine_configuration
  node                        = each.value.ip

  config_patches = [
    yamlencode({
      machine = {
        network = {
          hostname = each.key
          interfaces = [{
            interface = "eth0"
            addresses = ["${each.value.ip}/24"]
            routes = [{
              network = "0.0.0.0/0"
              gateway = var.network_gateway
            }]
          }]
        }
        certSANs = concat(
          [var.cluster_endpoint],
          [for k, v in var.control_plane_nodes : v.ip]
        )
      }
    })
  ]
}

resource "talos_machine_configuration_apply" "worker" {
  for_each = var.worker_nodes

  depends_on = [proxmox_virtual_environment_vm.talos]

  client_configuration        = talos_machine_secrets.this.client_configuration
  machine_configuration_input = data.talos_machine_configuration.worker.machine_configuration
  node                        = each.value.ip

  config_patches = concat(
    [
      yamlencode({
        machine = {
          network = {
            hostname = each.key
            interfaces = [{
              interface = "eth0"
              addresses = ["${each.value.ip}/24"]
              routes = [{
                network = "0.0.0.0/0"
                gateway = var.network_gateway
              }]
            }]
          }
        }
      })
    ],
    # GPU-specific patches
    try(each.value.gpu, false) ? [var.gpu_config_patch] : []
  )
}

# Bootstrap the cluster
resource "talos_machine_bootstrap" "this" {
  count = var.bootstrap_cluster ? 1 : 0

  depends_on = [
    talos_machine_configuration_apply.controlplane,
    talos_machine_configuration_apply.worker
  ]

  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = values(var.control_plane_nodes)[0].ip
}

# Generate kubeconfig
data "talos_cluster_kubeconfig" "this" {
  depends_on = [talos_machine_bootstrap.this]

  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = values(var.control_plane_nodes)[0].ip
}

# Save talosconfig locally
resource "local_sensitive_file" "talosconfig" {
  content  = data.talos_client_configuration.this.talos_config
  filename = "${path.root}/talosconfig"
}

# Save kubeconfig locally
resource "local_sensitive_file" "kubeconfig" {
  content  = data.talos_cluster_kubeconfig.this.kubeconfig_raw
  filename = "${path.root}/kubeconfig"
}
