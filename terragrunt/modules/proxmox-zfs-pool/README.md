# Proxmox ZFS Pool Module

This module manages ZFS storage pools in Proxmox for VM storage.

## Overview

The module creates a Proxmox resource pool for organizational purposes and optionally configures an existing ZFS pool as Proxmox storage.

**Important:** This module does not create the actual ZFS pool at the filesystem level. The ZFS pool must be created manually or via Ansible before using this module.

## Prerequisites

### Manual ZFS Pool Creation

For RAID-1 mirror configuration with 2x 1TB NVMe drives:

```bash
# On the Proxmox host
zpool create -f vm-storage mirror /dev/nvme0n1 /dev/nvme1n1

# Set ZFS properties for optimal VM performance
zfs set compression=lz4 vm-storage
zfs set atime=off vm-storage
zfs set recordsize=128K vm-storage
```

## Usage

```hcl
module "zfs_pool" {
  source = "../../modules/proxmox-zfs-pool"

  pool_name     = "homelab"
  pool_comment  = "Homelab infrastructure pool"
  proxmox_node  = "pve"

  # Only enable after ZFS pool exists
  create_storage_config = true
  storage_id            = "vm-storage"
  zfs_pool_name         = "vm-storage"
  thin_provisioning     = true

  content_types = ["images", "rootdir"]
}
```

## Variables

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| pool_name | Name of the Proxmox resource pool | `string` | "homelab" | no |
| pool_comment | Comment for the resource pool | `string` | "Homelab infrastructure resources" | no |
| proxmox_node | Name of the Proxmox node | `string` | n/a | yes |
| create_storage_config | Whether to configure the storage (requires existing ZFS pool) | `bool` | false | no |
| storage_id | Storage identifier in Proxmox | `string` | "vm-storage" | no |
| zfs_pool_name | Name of the ZFS pool | `string` | "vm-storage" | no |
| thin_provisioning | Enable thin provisioning | `bool` | true | no |
| content_types | Allowed content types | `list(string)` | ["images", "rootdir"] | no |

## Outputs

| Name | Description |
|------|-------------|
| pool_id | The ID of the created Proxmox resource pool |
| storage_id | The storage ID in Proxmox |
| zfs_pool_name | The name of the ZFS pool |

## Notes

- The ZFS pool must exist before setting `create_storage_config = true`
- Recommended ZFS properties for VM storage:
  - `compression=lz4` - Light compression for performance
  - `atime=off` - Disable access time updates
  - `recordsize=128K` - Optimal for VMs (matches volblocksize)
- For RAID-1 mirror, pool capacity will be the size of the smallest disk
- Regular scrubs recommended: `zpool scrub vm-storage` (monthly)

## Related Documentation

- [Proxmox ZFS Documentation](https://pve.proxmox.com/wiki/ZFS_on_Linux)
- [ZFS Best Practices](https://pve.proxmox.com/wiki/ZFS:_Tips_and_Tricks)
