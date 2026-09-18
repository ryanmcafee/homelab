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
- Broadcom 9400-8i HBA (11x 20TB HDDs + 2x 1TB NVMe)

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

  # HBA Passthrough: one entry per controller. Each entry becomes a Proxmox
  # PCI hardware mapping and a hostpciN device on the VM.
  hba_passthrough_enabled = true
  hba_devices = {
    "hba-sas" = {
      pci_id       = "0000:03:00.0" # Broadcom 9400-8i
      device_id    = "1000:0097"
      subsystem_id = "1000:3090"
      iommu_group  = 15
      description  = "Broadcom SAS HBA"
    }
  }

  # Network (management NIC; see Dual Network below for a second NIC)
  network_bridge  = "vmbr0"
  network_vlan_id = null

  # Install source: clone a template, or attach the ISO when use_template = false.
  # The ISO inputs have no defaults, so the unit always pins the release.
  use_template         = true
  template_vm_id       = 9000
  iso_storage          = "local"
  truenas_iso_url      = "https://download.sys.truenas.net/TrueNAS-SCALE-Goldeye/25.10.1/TrueNAS-SCALE-25.10.1.iso"
  truenas_iso_filename = "truenas-scale-25.10.1.iso"
  boot_order           = ["virtio0", "ide2"]

  # DNS records (UniFi provider), keyed by FQDN
  dns_entries = [
    { fqdn = "truenas.<BASE_FQDN>", type = "A", host = "192.0.2.150" }
  ]

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

With `use_template = true` the VM is a full clone of `template_vm_id`: no ISO is
downloaded or attached (`iso_id` is `null`) and step 1 is skipped. Setting
`wait_for_api = true` polls `truenas_api_url` (`/api/v2.0/system/info`) for up
to 10 minutes before anything else runs.

With `run_ansible_setup = true` the module runs, from `ansible_working_dir`:

```bash
mise exec -- ansible-playbook -i inventory/homelab.yml playbooks/truenas-full-setup.yml
```

passing `truenas_static_ip`, `truenas_gateway`, `truenas_hostname`,
`lan_network_enabled` and `truenas_lan_static_ip` as extra vars, and
`TRUENAS_ADMIN_PASSWORD` / `CLOUDFLARE_API_TOKEN` through the environment
(`MISE_CONFIG_FILE` points at the repo `mise.toml`). `inventory/homelab.yml` is
gitignored and rendered from `configuration/` by `task ansible:inventory`, so run
that before applying.

### Example ZFS Pool Configuration

For 11x 20TB HDDs + 2x 1TB NVMe (via HBA passthrough):

```bash
# In TrueNAS:
# 1. Go to Storage > Pools > Create Pool
# 2. Name: storage
# 3. Data VDEVs: RAIDZ3 with 11x 20TB HDDs
# 4. Metadata (Special) VDEV: Mirror with 2x 1TB NVMe
# 5. Create

# Or via CLI:
zpool create -f storage RAIDZ3 \
  /dev/sda /dev/sdb /dev/sdc /dev/sdd \
  /dev/sde /dev/sdf /dev/sdg /dev/sdh \
  /dev/sdi /dev/sdj /dev/sdk \
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
- `network_vlan_id` tags the management NIC (null = untagged)

### Dual Network (Optional)
- Separate management and LAN/storage networks
- Dedicated VLAN for NFS/SMB traffic
- Improved performance and security

```hcl
lan_network_enabled = true
lan_network_bridge  = "vmbr0"
lan_network_vlan_id = 10

# Address Ansible assigns to the second NIC (CIDR); only used with run_ansible_setup
truenas_lan_static_ip = "192.0.2.150/24"
```

## Variables

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| vm_name | VM name (also added to tags) | `string` | "truenas" | no |
| node_name | Proxmox node | `string` | n/a | yes |
| pool_id | Proxmox resource pool | `string` | null | no |
| tags | Extra VM tags (merged with `truenas`, `storage`, `vm_name`) | `list(string)` | [] | no |
| started | Start VM after creation | `bool` | true | no |
| on_boot | Start VM on Proxmox boot | `bool` | true | no |
| vm_id | Explicit VM ID | `number` | null | no |
| cpu_cores | CPU cores (host type, `+aes`) | `number` | 4 | no |
| memory_mb | Memory in MB | `number` | 32768 | no |
| boot_disk_datastore | Boot and EFI disk datastore | `string` | n/a | yes |
| boot_disk_size | Boot disk size (GB) | `number` | 32 | no |
| iso_storage | Datastore for the ISO download | `string` | "local" | no |
| truenas_iso_url | TrueNAS Scale ISO URL (used when `use_template = false`) | `string` | n/a | yes |
| truenas_iso_filename | ISO file name (used when `use_template = false`) | `string` | n/a | yes |
| hba_passthrough_enabled | Enable HBA passthrough | `bool` | true | no |
| hba_devices | Controllers to pass through: `{ pci_id, device_id, subsystem_id, iommu_group, description }` per key | `map(object)` | {} | no* |
| network_bridge | Management NIC bridge | `string` | "vmbr0" | no |
| network_vlan_id | Management VLAN | `number` | null | no |
| lan_network_enabled | Add a second NIC | `bool` | false | no |
| lan_network_bridge | Second NIC bridge | `string` | "vmbr0" | no |
| lan_network_vlan_id | Second NIC VLAN | `number` | null | no |
| boot_order | VM boot order | `list(string)` | ["ide2", "virtio0"] | no |
| wait_for_api | Poll the TrueNAS API before continuing | `bool` | false | no |
| truenas_api_url | API base URL for `wait_for_api` | `string` | "" | no |
| dns_entries | UniFi DNS records: `{ fqdn, type, host }` | `list(object)` | [] | no |
| dns_ttl | DNS record TTL (seconds) | `number` | 300 | no |
| use_template | Full-clone `template_vm_id` instead of installing from ISO | `bool` | false | no |
| template_vm_id | Template VM to clone | `number` | 9000 | no |
| truenas_static_ip | Management IP (CIDR) passed to Ansible | `string` | see variables.tf** | no |
| truenas_gateway | Gateway passed to Ansible | `string` | see variables.tf** | no |
| truenas_hostname | Hostname passed to Ansible | `string` | see variables.tf** | no |
| truenas_lan_static_ip | Second NIC IP (CIDR) passed to Ansible | `string` | "" | no |
| run_ansible_setup | Run `playbooks/truenas-full-setup.yml` after the VM is up | `bool` | false | no |
| ansible_working_dir | Directory the playbook runs from | `string` | "../../../ansible" | no |
| truenas_admin_password | Admin password for the playbook (sensitive) | `string` | "" | no |
| cloudflare_api_token | Cloudflare token for ACME DNS-01 (sensitive) | `string` | "" | no |

\*With `hba_passthrough_enabled = true` and an empty map nothing is passed through.

\*\*These defaults carry environment-specific addresses; the homelab unit
overrides them from `env.hcl`, which is rendered from `configuration/`.

## Outputs

| Name | Description |
|------|-------------|
| vm_id | TrueNAS VM ID |
| vm_name | TrueNAS VM name |
| ipv4_addresses | Assigned IPv4 addresses |
| mac_addresses | Network interface MAC addresses |
| iso_id | Downloaded ISO file ID (`null` when `use_template = true`) |
| dns_records | Map of FQDN to UniFi DNS record ID |

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
