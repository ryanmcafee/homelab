# Generic Proxmox VM Module

This module provides a flexible way to create and manage virtual machines in Proxmox with support for advanced features like PCI passthrough, cloud-init, and custom disk configurations.

## Features

- Flexible CPU and memory configuration
- Multiple disk support with per-disk settings
- Network device configuration with VLAN support
- PCI passthrough for GPUs, NICs, and other devices
- Cloud-init integration
- QEMU guest agent support
- Customizable boot order and VGA settings

## Usage

### Basic VM

```hcl
module "basic_vm" {
  source = "../../modules/proxmox-vm"

  vm_name   = "test-vm"
  node_name = "pve"

  cpu_cores = 4
  memory_mb = 8192

  boot_disk_datastore = "vm-storage"
  boot_disk_size      = 50

  network_devices = [{
    bridge  = "vmbr0"
    vlan_id = 100
  }]
}
```

### VM with Cloud-Init

```hcl
module "cloudinit_vm" {
  source = "../../modules/proxmox-vm"

  vm_name   = "ubuntu-vm"
  node_name = "pve"

  cpu_cores = 2
  memory_mb = 4096

  boot_disk_datastore = "vm-storage"
  boot_disk_file_id   = "local:iso/ubuntu-22.04-cloudimg-amd64.img"
  boot_disk_size      = 32

  cloud_init_enabled = true
  cloud_init_ip_configs = [{
    ipv4_address = "172.16.100.50/24"
    ipv4_gateway = "172.16.100.1"
  }]
  cloud_init_dns_servers = ["172.16.100.1"]
  cloud_init_ssh_keys    = [
    "ssh-rsa AAAAB3NzaC1yc2E... user@host"
  ]

  network_devices = [{
    bridge  = "vmbr0"
    vlan_id = 100
  }]
}
```

### VM with GPU Passthrough

```hcl
module "gpu_vm" {
  source = "../../modules/proxmox-vm"

  vm_name   = "plex-server"
  node_name = "pve"

  cpu_cores = 8
  cpu_type  = "host"
  memory_mb = 16384

  boot_disk_datastore = "vm-storage"
  boot_disk_size      = 100

  # Pass through NVIDIA GPU
  hostpci_devices = [{
    device = "hostpci0"
    id     = "0000:01:00.0"  # GPU PCI address
    pcie   = true
    rombar = true
  }]

  network_devices = [{
    bridge  = "vmbr0"
    vlan_id = 100
  }]
}
```

### VM with Multiple Disks

```hcl
module "storage_vm" {
  source = "../../modules/proxmox-vm"

  vm_name   = "storage-server"
  node_name = "pve"

  cpu_cores = 4
  memory_mb = 8192

  boot_disk_datastore = "vm-storage"
  boot_disk_size      = 32

  # Additional data disks
  additional_disks = [
    {
      datastore_id = "vm-storage"
      size         = 500
      interface    = "scsi1"
      ssd          = true
      iothread     = true
    },
    {
      datastore_id = "vm-storage"
      size         = 1000
      interface    = "scsi2"
      ssd          = false
    }
  ]

  network_devices = [{
    bridge = "vmbr0"
  }]
}
```

## Variables

See `variables.tf` for comprehensive variable documentation.

### Key Variables

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| vm_name | Name of the VM | `string` | n/a | yes |
| node_name | Proxmox node name | `string` | n/a | yes |
| cpu_cores | Number of CPU cores | `number` | 2 | no |
| memory_mb | Memory in MB | `number` | 4096 | no |
| boot_disk_datastore | Boot disk storage | `string` | n/a | yes |
| boot_disk_size | Boot disk size in GB | `number` | 32 | no |
| network_devices | Network configuration | `list(object)` | See variables.tf | no |
| hostpci_devices | PCI passthrough devices | `list(object)` | [] | no |
| cloud_init_enabled | Enable cloud-init | `bool` | false | no |

## Outputs

| Name | Description |
|------|-------------|
| vm_id | The VM ID |
| vm_name | The VM name |
| ipv4_addresses | IPv4 addresses |
| ipv6_addresses | IPv6 addresses |
| mac_addresses | MAC addresses |

## PCI Passthrough

To use PCI passthrough:

1. Enable IOMMU in BIOS
2. Enable IOMMU in Proxmox (via GRUB)
3. Identify PCI device address: `lspci -nn`
4. Configure device passthrough

Example GPU passthrough:
```bash
# Find GPU PCI address
lspci -nn | grep -i nvidia
# Output: 01:00.0 VGA compatible controller [0300]: NVIDIA Corporation ...

# Use in hostpci_devices
id = "0000:01:00.0"
```

## Cloud-Init

For cloud-init to work:
- Use a cloud-init enabled image
- Install qemu-guest-agent in the VM
- Configure network and user settings

## Notes

- Set `cpu_type = "host"` for best performance
- Enable `iothread` for SSD/NVMe disks
- Use `discard = "on"` with SSDs for TRIM support
- QEMU guest agent enables better integration and cleaner shutdowns
- For GPU passthrough, ensure the GPU is not used by the host

## Related Documentation

- [Proxmox VM Management](https://pve.proxmox.com/wiki/Qemu/KVM_Virtual_Machines)
- [PCI Passthrough](https://pve.proxmox.com/wiki/PCI_Passthrough)
- [Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support)
