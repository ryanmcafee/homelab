# TrueNAS Scale VM Module

This module provisions a TrueNAS Scale VM in Proxmox with HBA passthrough for direct disk access and ZFS management.

## Overview

TrueNAS Scale is deployed as a VM with:
- HBA passthrough for direct access to storage drives
- UEFI boot for modern hardware support
- Sufficient RAM for ZFS ARC cache
- Host CPU type for optimal performance

## Hardware Requirements

### Minimum
- 4 CPU cores
- 8GB RAM
- 32GB boot disk

### Recommended
- 4-8 CPU cores
- 32GB+ RAM (for ZFS ARC cache)
- 32GB boot disk (SSD/NVMe)
- HBA controller for disk passthrough

### Optimal (This Homelab)
- 4 CPU cores (host type)
- 32GB RAM
- 32GB NVMe boot disk
- Broadcom 9400-8i HBA (8x 20TB HDDs + 2x 1TB NVMe)

## HBA Passthrough

### Prerequisites

1. **Enable IOMMU in BIOS**
   - Intel: VT-d
   - AMD: AMD-Vi

2. **Enable IOMMU in Proxmox**
   ```bash
   # Edit GRUB config
   nano /etc/default/grub

   # Intel:
   GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"

   # AMD:
   GRUB_CMDLINE_LINUX_DEFAULT="quiet amd_iommu=on iommu=pt"

   # Update GRUB
   update-grub
   reboot
   ```

3. **Identify HBA PCI Address**
   ```bash
   lspci -nn | grep -i broadcom
   # Example output: 03:00.0 Serial Attached SCSI controller [0107]: Broadcom / LSI SAS3008 PCI-Express Fusion-MPT SAS-3 [1000:0097]
   ```

4. **Verify IOMMU Groups**
   ```bash
   for d in /sys/kernel/iommu_groups/*/devices/*; do
     n=${d#*/iommu_groups/*}; n=${n%%/*}
     printf 'IOMMU Group %s ' "$n"
     lspci -nns "${d##*/}"
   done | grep 03:00.0
   ```

### Usage

```hcl
module "truenas" {
  source = "../../modules/truenas"

  vm_name   = "truenas"
  node_name = "pve"
  pool_id   = "homelab"

  # Resources
  cpu_cores = 4
  memory_mb = 32768

  # Storage
  boot_disk_datastore = "vm-storage"
  boot_disk_size      = 32

  # HBA Passthrough
  hba_passthrough_enabled = true
  hba_pci_id              = "0000:03:00.0"  # Broadcom 9400-8i

  # Network
  network_bridge  = "vmbr0"
  network_vlan_id = 100

  # TrueNAS ISO
  iso_storage           = "local"
  truenas_iso_url       = "https://download.truenas.com/TrueNAS-SCALE-Dragonfish/23.10.1/TrueNAS-SCALE-23.10.1.iso"
  truenas_iso_filename  = "truenas-scale-23.10.1.iso"

  tags = ["production", "storage"]
}
```

## Post-Installation

After the VM is created, you'll need to:

1. **Access TrueNAS Console** - Complete initial installation via Proxmox console
2. **Configure Network** - Set static IP or verify DHCP assignment
3. **Access Web UI** - Navigate to TrueNAS web interface
4. **Create Storage Pools** - Configure ZFS pools using passed-through disks
5. **Configure NFS/SMB** - Set up network shares

### Example ZFS Pool Configuration

For 8x 20TB HDDs + 2x 1TB NVMe (via HBA passthrough):

```bash
# In TrueNAS:
# 1. Go to Storage > Pools > Create Pool
# 2. Name: storage
# 3. Data VDEVs: RAIDZ3 with 8x 20TB HDDs
# 4. Metadata (Special) VDEV: Mirror with 2x 1TB NVMe
# 5. Create

# Or via CLI:
zpool create -f storage RAIDZ3 \
  /dev/sda /dev/sdb /dev/sdc /dev/sdd \
  /dev/sde /dev/sdf /dev/sdg /dev/sdh \
  special mirror /dev/nvme0n1 /dev/nvme1n1

# Set optimal properties
zfs set compression=lz4 storage
zfs set atime=off storage
zfs set recordsize=128K storage
```

## Network Configuration

### Single Network (Default)
- Management and storage traffic on same network
- Suitable for smaller deployments
- VLAN 100 for network isolation

### Dual Network (Optional)
- Separate management and storage networks
- Dedicated storage VLAN for NFS/SMB traffic
- Improved performance and security

```hcl
storage_network_enabled = true
storage_network_bridge  = "vmbr0"
storage_network_vlan_id = 200
```

## Variables

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| vm_name | VM name | `string` | "truenas" | no |
| node_name | Proxmox node | `string` | n/a | yes |
| cpu_cores | CPU cores | `number` | 4 | no |
| memory_mb | Memory in MB | `number` | 32768 | no |
| boot_disk_datastore | Boot disk storage | `string` | n/a | yes |
| boot_disk_size | Boot disk size (GB) | `number` | 32 | no |
| hba_passthrough_enabled | Enable HBA passthrough | `bool` | true | no |
| hba_pci_id | HBA PCI address | `string` | "" | yes* |
| network_vlan_id | Management VLAN | `number` | null | no |

*Required when `hba_passthrough_enabled = true`

## Outputs

| Name | Description |
|------|-------------|
| vm_id | TrueNAS VM ID |
| vm_name | TrueNAS VM name |
| ipv4_addresses | Assigned IPv4 addresses |
| mac_addresses | Network interface MAC addresses |
| iso_id | Downloaded ISO file ID |

## Troubleshooting

### HBA Not Visible in TrueNAS

1. Verify IOMMU is enabled:
   ```bash
   dmesg | grep -i iommu
   ```

2. Check PCI passthrough in VM config:
   ```bash
   qm config <VMID> | grep hostpci
   ```

3. Verify device in VM:
   ```bash
   # From TrueNAS console
   lspci | grep -i broadcom
   ```

### Performance Issues

- Increase RAM for ZFS ARC
- Verify CPU type is set to "host"
- Check disk alignment and ZFS recordsize
- Monitor ZFS ARC hit rate

### Boot Issues

- Verify UEFI boot mode
- Check boot order in VM config
- Ensure EFI disk is created
- Verify ISO download completed

## Notes

- TrueNAS requires substantial RAM for ZFS (32GB recommended)
- HBA passthrough provides better performance than virtual disks
- Special vdev (NVMe mirror) accelerates metadata and small block performance
- Regular ZFS scrubs recommended (monthly)
- Keep TrueNAS updated for security and bug fixes

## Related Documentation

- [TrueNAS Scale Documentation](https://www.truenas.com/docs/scale/)
- [Proxmox PCI Passthrough](https://pve.proxmox.com/wiki/PCI_Passthrough)
- [ZFS Best Practices](https://www.truenas.com/docs/references/zfsprimer/)
- [Broadcom HBA Setup](https://www.truenas.com/docs/references/hbasupport/)
