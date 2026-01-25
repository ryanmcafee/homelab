/**
 * TrueNAS Scale Packer Template
 *
 * NOTE: TrueNAS SCALE does not support fully automated installation.
 * This Packer config creates a VM with the ISO attached, but manual
 * installation via Proxmox VNC console is required.
 *
 * Workflow:
 * 1. Run: task truenas:build-template
 * 2. Complete installation via Proxmox VNC console
 * 3. Run: task truenas:finalize-template
 */

packer {
  required_plugins {
    proxmox = {
      version = ">= 1.2.2"
      source  = "github.com/hashicorp/proxmox"
    }
  }
}

source "proxmox-iso" "truenas" {
  # Proxmox connection
  proxmox_url              = var.proxmox_url
  username                 = var.proxmox_username
  token                    = var.proxmox_token
  insecure_skip_tls_verify = var.proxmox_skip_tls_verify
  node                     = var.proxmox_node

  # VM settings
  vm_id                = var.template_vm_id
  vm_name              = var.template_name
  template_description = "TrueNAS Scale ${var.truenas_version} - requires manual installation"

  # ISO configuration - keep ISO attached for manual installation
  iso_url          = "https://download.sys.truenas.net/TrueNAS-SCALE-Goldeye/${var.truenas_version}/TrueNAS-SCALE-${var.truenas_version}.iso"
  iso_checksum     = "none"
  iso_storage_pool = var.iso_storage
  unmount_iso      = false  # Keep ISO for manual installation

  # Hardware configuration
  qemu_agent      = false
  machine         = "q35"
  bios            = "ovmf"
  cpu_type        = "host"
  cores           = var.cpu_cores
  memory          = var.memory_mb
  scsi_controller = "virtio-scsi-single"
  os              = "other"

  # VGA - use std for better VNC compatibility
  vga {
    type = "std"
  }

  # EFI disk for UEFI boot
  efi_config {
    efi_storage_pool  = var.vm_storage
    efi_type          = "4m"
    pre_enrolled_keys = false
  }

  # Boot disk
  disks {
    type         = "virtio"
    disk_size    = var.boot_disk_size
    storage_pool = var.vm_storage
    format       = "raw"
  }

  # Network
  network_adapters {
    bridge = "vmbr0"
    model  = "virtio"
  }

  # No boot_command - manual installation required
  # TrueNAS installer timing is too unpredictable for automation
  boot_wait = "5s"

  # Communicator - none since manual installation is required
  communicator = "none"
}

build {
  sources = ["source.proxmox-iso.truenas"]

  # Post-build note
  post-processor "shell-local" {
    inline = [
      "echo ''",
      "echo '=============================================='",
      "echo 'MANUAL INSTALLATION REQUIRED'",
      "echo '=============================================='",
      "echo '1. Open Proxmox web UI: https://${var.proxmox_node}:8006'",
      "echo '2. Select VM ${var.template_vm_id} and open Console'",
      "echo '3. Complete TrueNAS installation'",
      "echo '4. Run: task truenas:finalize-template'",
      "echo '=============================================='"
    ]
  }
}
