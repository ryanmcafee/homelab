/**
 * Generic Proxmox VM Module
 *
 * Creates and manages virtual machines in Proxmox with flexible configuration.
 * Supports cloud-init, PCI passthrough, and various storage options.
 */

terraform {
  required_version = ">= 1.7.0"
}

resource "proxmox_virtual_environment_vm" "this" {
  name        = var.vm_name
  description = var.description
  node_name   = var.node_name
  pool_id     = var.pool_id
  tags        = distinct(concat([var.vm_name], var.tags))

  started     = var.started
  on_boot     = var.on_boot
  vm_id       = var.vm_id

  cpu {
    cores   = var.cpu_cores
    sockets = var.cpu_sockets
    type    = var.cpu_type
    flags   = var.cpu_flags
  }

  memory {
    dedicated = var.memory_mb
    floating  = var.memory_floating
  }

  # Boot disk
  disk {
    datastore_id = var.boot_disk_datastore
    file_id      = var.boot_disk_file_id
    size         = var.boot_disk_size
    interface    = var.boot_disk_interface
    iothread     = var.boot_disk_iothread
    ssd          = var.boot_disk_ssd
    discard      = var.boot_disk_discard
  }

  # Additional disks
  dynamic "disk" {
    for_each = var.additional_disks
    content {
      datastore_id = disk.value.datastore_id
      size         = disk.value.size
      interface    = disk.value.interface
      iothread     = try(disk.value.iothread, false)
      ssd          = try(disk.value.ssd, false)
      discard      = try(disk.value.discard, "on")
    }
  }

  # Network interfaces
  dynamic "network_device" {
    for_each = var.network_devices
    content {
      bridge      = network_device.value.bridge
      vlan_id     = try(network_device.value.vlan_id, null)
      mac_address = try(network_device.value.mac_address, null)
      model       = try(network_device.value.model, "virtio")
      firewall    = try(network_device.value.firewall, false)
    }
  }

  # PCI passthrough devices
  dynamic "hostpci" {
    for_each = var.hostpci_devices
    content {
      device  = hostpci.value.device
      id      = hostpci.value.id
      pcie    = try(hostpci.value.pcie, true)
      rombar  = try(hostpci.value.rombar, true)
      xvga    = try(hostpci.value.xvga, false)
      mapping = try(hostpci.value.mapping, null)
    }
  }

  # Cloud-init configuration
  dynamic "initialization" {
    for_each = var.cloud_init_enabled ? [1] : []
    content {
      datastore_id = var.cloud_init_datastore

      dynamic "ip_config" {
        for_each = var.cloud_init_ip_configs
        content {
          ipv4 {
            address = try(ip_config.value.ipv4_address, "dhcp")
            gateway = try(ip_config.value.ipv4_gateway, null)
          }
          dynamic "ipv6" {
            for_each = try(ip_config.value.ipv6_address, null) != null ? [1] : []
            content {
              address = ip_config.value.ipv6_address
              gateway = try(ip_config.value.ipv6_gateway, null)
            }
          }
        }
      }

      dns {
        servers = var.cloud_init_dns_servers
        domain  = var.cloud_init_dns_domain
      }

      user_account {
        username = var.cloud_init_username
        password = var.cloud_init_password
        keys     = var.cloud_init_ssh_keys
      }

      user_data_file_id = var.cloud_init_user_data_file_id
    }
  }

  # Boot order
  boot_order = var.boot_order

  # Agent configuration
  agent {
    enabled = var.agent_enabled
    timeout = var.agent_timeout
    trim    = var.agent_trim
  }

  # VGA configuration
  vga {
    type   = var.vga_type
    memory = var.vga_memory
  }

  # Lifecycle settings
  lifecycle {
    ignore_changes = var.lifecycle_ignore_changes
  }
}
