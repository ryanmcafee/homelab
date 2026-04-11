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
  # Sorted control plane node keys for stable ordering
  controlplane_keys = sort(keys(var.control_plane_nodes))

  # Sorted worker node keys for stable ordering
  worker_keys = sort(keys(var.worker_nodes))

  # Merge control plane and worker node configurations (control planes first, then workers)
  # This creates a stable ordering: cp-1, cp-2, worker-1, worker-2, worker-3
  all_nodes = merge(
    { for k, v in var.control_plane_nodes : k => merge(v, { machine_type = "controlplane" }) },
    { for k, v in var.worker_nodes : k => merge(v, { machine_type = "worker" }) }
  )

  # Ordered list of all node keys (control planes first, then workers)
  ordered_node_keys = concat(local.controlplane_keys, local.worker_keys)

  # Generate VM IDs: control planes start at vm_id_base, workers start at worker_vm_id_base
  # Example: vm_id_base=101, worker_vm_id_base=110
  # cp-1=101, cp-2=102, worker-1=110, worker-2=111, worker-3=112
  controlplane_vm_ids = {
    for idx, k in local.controlplane_keys : k => var.vm_id_base + idx
  }

  worker_vm_ids = {
    for idx, k in local.worker_keys : k => var.worker_vm_id_base + idx
  }

  # Combined VM IDs for all nodes
  all_vm_ids = merge(local.controlplane_vm_ids, local.worker_vm_ids)

  # GPU vendor selection - picks active vendor's configuration
  # When gpu_vendor = "nvidia" (default), all active_gpu_* locals resolve to existing NVIDIA values
  # This ensures zero Terraform state change for the current cluster configuration
  active_gpu_pci_id          = var.gpu_vendor == "intel" ? var.gpu_intel_pci_id : var.gpu_pci_id
  active_gpu_device          = var.gpu_vendor == "intel" ? var.gpu_intel_device : var.gpu_device
  active_gpu_mapping_name    = var.gpu_vendor == "intel" ? var.gpu_intel_mapping_name : var.gpu_mapping_name
  active_gpu_config_patch    = var.gpu_vendor == "intel" ? var.gpu_intel_config_patch : var.gpu_config_patch
  active_gpu_installer_image = var.gpu_vendor == "intel" ? var.gpu_intel_installer_image : var.gpu_installer_image

  # GPU enabled when vendor is not "none", device is configured, and at least one worker has GPU flag
  gpu_enabled = var.gpu_vendor != "none" && local.active_gpu_device != null && anytrue([for k, v in var.worker_nodes : try(v.gpu, false)])

  # Generate deterministic MAC addresses for each node based on IP
  # Format: bc:24:11:xx:xx:xx where xx:xx:xx is derived from last octet of IP
  # This ensures consistent MAC addresses across terraform runs
  # NOTE: Must be lowercase for Talos deviceSelector matching
  node_mac_addresses = {
    for k, v in local.all_nodes : k => lower(format(
      "BC:24:11:%02X:%02X:%02X",
      tonumber(split(".", v.ip)[2]),
      tonumber(split(".", v.ip)[3]),
      index(local.ordered_node_keys, k) + 1
    ))
  }

  # Image cache configuration - generates registry mirror config when image_cache_endpoint is set
  image_cache_enabled = var.image_cache_endpoint != ""

  # Generate registry mirrors configuration with image cache as primary endpoint
  # Falls back to original registries if cache is unavailable
  image_cache_mirrors = local.image_cache_enabled ? {
    for registry in var.image_cache_registries : registry => {
      endpoints = concat(
        [var.image_cache_endpoint],
        # Add original endpoints as fallback
        registry == "docker.io" ? ["https://registry-1.docker.io"] :
        registry == "ghcr.io" ? ["https://ghcr.io"] :
        registry == "registry.k8s.io" ? ["https://registry.k8s.io"] :
        registry == "gcr.io" ? ["https://gcr.io"] :
        registry == "quay.io" ? ["https://quay.io"] :
        []
      )
      overridePath = true
    }
  } : {}

  # Image cache machine config patch (applied to all nodes when cache is enabled)
  image_cache_config_patch = local.image_cache_enabled ? [
    yamlencode({
      machine = {
        registries = {
          mirrors = local.image_cache_mirrors
        }
      }
    })
  ] : []

  # Trusted CA certificate patch for image cache (when self-signed cert is provided)
  image_cache_ca_patch = var.image_cache_ca_cert != "" ? [
    yamlencode({
      machine = {
        files = [
          {
            path        = "/etc/ssl/certs/image-cache-ca.crt"
            permissions = 420 # 0644 in octal
            content     = var.image_cache_ca_cert
          }
        ]
        registries = {
          config = {
            "${var.image_cache_endpoint}" = {
              tls = {
                ca = var.image_cache_ca_cert
              }
            }
          }
        }
      }
    })
  ] : []

  # Spegel P2P image cache configuration
  # Talos discards unpacked layers by default, which breaks Spegel's ability to serve cached images.
  # This patch configures containerd to preserve unpacked layers.
  # See: https://spegel.dev/docs/getting-started/#talos
  spegel_config_patch = var.spegel_enabled ? [
    yamlencode({
      machine = {
        files = [
          {
            path    = "/etc/cri/conf.d/20-customization.part"
            op      = "create"
            content = <<-EOT
              [plugins."io.containerd.cri.v1.images"]
                discard_unpacked_layers = false
            EOT
          }
        ]
      }
    })
  ] : []
}

# PCI Hardware Mapping for GPU passthrough (required for non-root API tokens)
resource "proxmox_virtual_environment_hardware_mapping_pci" "gpu" {
  count = local.gpu_enabled ? 1 : 0

  name    = local.active_gpu_mapping_name
  comment = local.active_gpu_device.description

  map = [{
    id           = local.active_gpu_device.device_id
    node         = var.proxmox_node
    path         = local.active_gpu_pci_id
    iommu_group  = local.active_gpu_device.iommu_group
    subsystem_id = local.active_gpu_device.subsystem_id
  }]
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

# Generate machine configurations for each control plane node (with network config baked in)
data "talos_machine_configuration" "controlplane" {
  for_each = var.control_plane_nodes

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
    # Image cache configuration (registry mirrors + CA certificate)
    local.image_cache_config_patch,
    local.image_cache_ca_patch,
    # Spegel P2P image cache configuration
    local.spegel_config_patch,
    [
      yamlencode({
        cluster = {
          network = {
            # Cillium is installed via inline manifests during bootstrap and again via ArgoCD
            cni = {
              name = "none"
            }
          }
          proxy = {
            disabled = true # Cilium handles this
          }
          allowSchedulingOnControlPlanes = var.allow_scheduling_on_control_planes
          # Explicitly set etcd advertised subnets to avoid stale IPs from DHCP/VIP
          etcd = {
            advertisedSubnets = [var.network_cidr, "!${var.vip_endpoint}/32"]
          }
        }
      }),
      # Network configuration baked into machine config for boot-time static IP
      # NOTE: hostname is set via meta-data, not in machine config (nocloud requirement)
      # VIP configuration enables HA API access on cluster_endpoint
      yamlencode({
        machine = {
          network = {
            nameservers = var.dns_servers
            interfaces = [{
              deviceSelector = {
                hardwareAddr = local.node_mac_addresses[each.key]
              }
              addresses = ["${each.value.ip}/24"]
              routes = [{
                network = "0.0.0.0/0"
                gateway = var.network_gateway
              }]
              vip = {
                ip = var.vip_endpoint
              }
            }]
          }
          certSANs = concat(
            [var.cluster_endpoint],
            [var.vip_endpoint],
            [for k, v in var.control_plane_nodes : v.ip]
          )
        }
      })
    ],
    # Custom installer image for system extensions (from Image Factory)
    var.installer_image != null ? [
      yamlencode({
        machine = {
          install = {
            image = var.installer_image
          }
        }
      })
    ] : [],
    # Inline manifests (only on first control plane to avoid duplication)
    # Includes Cilium CNI, kubelet-csr-approver, and Spegel for bootstrap
    each.key == keys(var.control_plane_nodes)[0] && (
      (var.install_cilium_inline && var.cilium_inline_manifest != "") ||
      (var.install_kubelet_csr_approver_inline && var.kubelet_csr_approver_inline_manifest != "") ||
      (var.install_spegel_inline && var.spegel_inline_manifest != "")
      ) ? [
      yamlencode({
        cluster = {
          inlineManifests = concat(
            var.install_cilium_inline && var.cilium_inline_manifest != "" ? [{
              name     = "cilium"
              contents = var.cilium_inline_manifest
            }] : [],
            var.install_kubelet_csr_approver_inline && var.kubelet_csr_approver_inline_manifest != "" ? [{
              name     = "kubelet-csr-approver"
              contents = var.kubelet_csr_approver_inline_manifest
            }] : [],
            var.install_spegel_inline && var.spegel_inline_manifest != "" ? [{
              name     = "spegel"
              contents = var.spegel_inline_manifest
            }] : []
          )
        }
      })
    ] : []
  )
}

# Generate machine configurations for each worker node (with network config baked in)
data "talos_machine_configuration" "worker" {
  for_each = var.worker_nodes

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
    var.worker_config_patches,
    # Image cache configuration (registry mirrors + CA certificate)
    local.image_cache_config_patch,
    local.image_cache_ca_patch,
    # Spegel P2P image cache configuration
    local.spegel_config_patch,
    [
      # Network configuration baked into machine config for boot-time static IP
      # NOTE: hostname is set via meta-data, not in machine config (nocloud requirement)
      yamlencode({
        machine = {
          network = {
            nameservers = var.dns_servers
            interfaces = [{
              deviceSelector = {
                hardwareAddr = local.node_mac_addresses[each.key]
              }
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
    # Custom installer image for system extensions (from Image Factory)
    # GPU nodes use vendor-specific installer image, others use base installer_image
    (try(each.value.gpu, false) ? local.active_gpu_installer_image : var.installer_image) != null ? [
      yamlencode({
        machine = {
          install = {
            image = try(each.value.gpu, false) ? coalesce(local.active_gpu_installer_image, var.installer_image) : var.installer_image
          }
        }
      })
    ] : [],
    # GPU-specific patches for workers with GPU enabled (vendor-conditional)
    try(each.value.gpu, false) && var.gpu_vendor != "none" ? [local.active_gpu_config_patch] : []
  )
}

# Cloud-init user-data files containing full Talos machine config
# Talos reads machine config from nocloud user-data, NOT network-config
resource "proxmox_virtual_environment_file" "machine_config" {
  for_each = local.all_nodes

  content_type = "snippets"
  datastore_id = "local"
  node_name    = each.value.host_node

  source_raw {
    # Deliver the complete Talos machine config (with network settings) via user-data
    data      = each.value.machine_type == "controlplane" ? data.talos_machine_configuration.controlplane[each.key].machine_configuration : data.talos_machine_configuration.worker[each.key].machine_configuration
    file_name = "talos-${each.key}-config.yaml"
  }
}

# Cloud-init meta-data files for nocloud platform
# Hostname must be set here, not in Talos machine config (nocloud requirement)
resource "proxmox_virtual_environment_file" "meta_data" {
  for_each = local.all_nodes

  content_type = "snippets"
  datastore_id = "local"
  node_name    = each.value.host_node

  source_raw {
    data      = "local-hostname: ${each.key}\ninstance-id: ${each.key}\n"
    file_name = "talos-${each.key}-meta-data"
  }
}

# Create Control Plane VMs in Proxmox (provisioned first)
resource "proxmox_virtual_environment_vm" "controlplane" {
  for_each = var.control_plane_nodes

  vm_id       = local.controlplane_vm_ids[each.key]
  name        = each.key
  description = "Talos controlplane node"
  node_name   = each.value.host_node
  pool_id     = var.pool_id
  tags        = distinct(concat(["talos", "kubernetes", "controlplane", each.key], var.tags))

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
    file_id   = var.talos_image_id
    interface = "ide2"
  }

  # Network device with explicit MAC address for cloud-init matching
  network_device {
    bridge      = var.network_bridge
    mac_address = local.node_mac_addresses[each.key]
  }

  # Cloud-init for Talos machine config delivery
  # Talos reads its config from nocloud user-data (NOT network-config)
  # Uses ide3 to avoid conflict with CDROM on ide2
  initialization {
    datastore_id = var.datastore_id
    interface    = "ide3"
    # nocloud format is required for Talos compatibility
    type = "nocloud"

    # Deliver the complete Talos machine config via user-data
    user_data_file_id = proxmox_virtual_environment_file.machine_config[each.key].id
    # Hostname is set via meta-data (nocloud requirement - cannot be in machine config)
    meta_data_file_id = proxmox_virtual_environment_file.meta_data[each.key].id
  }

  # Boot order - preferred boot from disk, but fallback to iso
  boot_order = ["scsi0", "ide2"]

  # QEMU agent
  agent {
    enabled = true
    timeout = var.qemu_agent_timeout
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

# Create Worker VMs in Proxmox (provisioned after control planes)
resource "proxmox_virtual_environment_vm" "worker" {
  for_each = var.worker_nodes

  # Workers are provisioned after control planes
  depends_on = [proxmox_virtual_environment_vm.controlplane]

  vm_id       = local.worker_vm_ids[each.key]
  name        = each.key
  description = "Talos worker node"
  node_name   = each.value.host_node
  pool_id     = var.pool_id
  tags        = distinct(concat(["talos", "kubernetes", "worker", each.key], var.tags))

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
    file_id   = var.talos_image_id
    interface = "ide2"
  }

  # GPU passthrough (for workers with GPU enabled)
  # Uses hardware mapping for non-root API token compatibility
  dynamic "hostpci" {
    for_each = try(each.value.gpu, false) && local.gpu_enabled ? [1] : []
    content {
      device  = "hostpci0"
      mapping = proxmox_virtual_environment_hardware_mapping_pci.gpu[0].name
      pcie    = true
      rombar  = true
      xvga    = false
    }
  }

  # Network device with explicit MAC address for cloud-init matching
  network_device {
    bridge      = var.network_bridge
    mac_address = local.node_mac_addresses[each.key]
  }

  # Cloud-init for Talos machine config delivery
  # Talos reads its config from nocloud user-data (NOT network-config)
  # Uses ide3 to avoid conflict with CDROM on ide2
  initialization {
    datastore_id = var.datastore_id
    interface    = "ide3"
    # nocloud format is required for Talos compatibility
    type = "nocloud"

    # Deliver the complete Talos machine config via user-data
    user_data_file_id = proxmox_virtual_environment_file.machine_config[each.key].id
    # Hostname is set via meta-data (nocloud requirement - cannot be in machine config)
    meta_data_file_id = proxmox_virtual_environment_file.meta_data[each.key].id
  }

  # Boot order - boot from disk, but fallback to CDROM (Talos ISO)
  boot_order = ["scsi0", "ide2"]

  # QEMU agent
  agent {
    enabled = true
    timeout = var.qemu_agent_timeout
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

# NOTE: Machine configuration apply, bootstrap, and kubeconfig resources
# have been moved to the talos-cluster-config module to allow infrastructure
# planning when the cluster is offline.
