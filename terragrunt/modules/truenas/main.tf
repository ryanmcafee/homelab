/**
 * TrueNAS Scale VM Module
 *
 * Provisions a TrueNAS Scale VM with HBA passthrough for direct disk access.
 * Designed for ZFS storage pool management with optimal performance.
 */

terraform {
  required_version = ">= 1.7.0"
}

# PCI Hardware Mappings for HBA passthrough
resource "proxmox_virtual_environment_hardware_mapping_pci" "hba_mappings" {
  for_each = var.hba_passthrough_enabled ? var.hba_devices : {}

  name    = each.key
  comment = each.value.description

  map = [{
    id           = each.value.device_id
    node         = var.node_name
    path         = each.value.pci_id
    iommu_group  = each.value.iommu_group
    subsystem_id = each.value.subsystem_id
  }]
}

# Download TrueNAS Scale ISO
resource "proxmox_virtual_environment_download_file" "truenas_iso" {
  content_type = "iso"
  datastore_id = var.iso_storage
  node_name    = var.node_name
  url          = var.truenas_iso_url
  file_name    = var.truenas_iso_filename

  # Only download if not already present
  overwrite = false
}

# TrueNAS Scale VM
resource "proxmox_virtual_environment_vm" "truenas" {
  name        = var.vm_name
  description = "TrueNAS Scale - Network Attached Storage"
  node_name   = var.node_name
  pool_id     = var.pool_id
  tags        = concat(["truenas", "storage"], var.tags)

  started = var.started
  on_boot = var.on_boot
  vm_id   = var.vm_id

  # CPU Configuration - TrueNAS benefits from host CPU type
  cpu {
    cores   = var.cpu_cores
    sockets = 1
    type    = "host"
    flags   = ["+aes"]  # Enable AES-NI for encryption
  }

  # Memory - Large allocation for ZFS ARC cache
  memory {
    dedicated = var.memory_mb
  }

  # Boot disk - OS only
  disk {
    datastore_id = var.boot_disk_datastore
    size         = var.boot_disk_size
    interface    = "virtio0"
    iothread     = true
    ssd          = true
    discard      = "on"
  }

  # HBA Passthrough - Direct disk access for ZFS
  # Supports multiple HBA controllers using PCI device mappings
  dynamic "hostpci" {
    for_each = var.hba_passthrough_enabled ? keys(var.hba_devices) : []
    content {
      device  = "hostpci${hostpci.key}"
      mapping = proxmox_virtual_environment_hardware_mapping_pci.hba_mappings[hostpci.value].name
      pcie    = true
      rombar  = true
      xvga    = false
    }
  }

  # Network Configuration
  network_device {
    bridge      = var.network_bridge
    vlan_id     = var.network_vlan_id
    model       = "virtio"
    firewall    = false
  }

  # Additional network interface (optional, for NFS traffic separation)
  dynamic "network_device" {
    for_each = var.storage_network_enabled ? [1] : []
    content {
      bridge      = var.storage_network_bridge
      vlan_id     = var.storage_network_vlan_id
      model       = "virtio"
      firewall    = false
    }
  }

  # Attach TrueNAS ISO for initial installation
  cdrom {
    enabled   = true
    file_id   = proxmox_virtual_environment_download_file.truenas_iso.id
    interface = "ide2"
  }

  # Boot order - CDROM first for installation, then boot disk
  boot_order = var.boot_order

  # QEMU Guest Agent
  # Disabled during bootstrap - TrueNAS needs manual installation first
  agent {
    enabled = false
  }

  # VGA - virtio for better UEFI compatibility
  vga {
    type   = "virtio"
    memory = 16
  }

  # Machine type - q35 for better PCIe support
  machine = "q35"

  # BIOS - OVMF (UEFI) for modern boot
  bios = "ovmf"

  # EFI disk for UEFI boot
  efi_disk {
    datastore_id = var.boot_disk_datastore
    file_format  = "raw"
    type         = "4m"
  }

  # Lifecycle - Ignore changes after initial creation
  lifecycle {
    ignore_changes = [
      disk,
      cdrom,
      boot_order,
    ]
  }
}

# Wait for TrueNAS to be accessible (post-installation)
resource "null_resource" "wait_for_truenas" {
  count = var.wait_for_api ? 1 : 0

  depends_on = [proxmox_virtual_environment_vm.truenas]

  provisioner "local-exec" {
    command = <<-EOF
      echo "Waiting for TrueNAS API to be available at ${var.truenas_api_url}..."
      for i in {1..60}; do
        if curl -k -s -f "${var.truenas_api_url}/api/v2.0/system/info" > /dev/null 2>&1; then
          echo "TrueNAS API is available!"
          exit 0
        fi
        echo "Attempt $i/60: TrueNAS not ready yet, waiting 10s..."
        sleep 10
      done
      echo "WARNING: TrueNAS API did not become available within 10 minutes"
      exit 1
    EOF
  }
}
