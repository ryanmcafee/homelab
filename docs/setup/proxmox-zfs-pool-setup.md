# Proxmox ZFS Pool Setup

Automated ZFS storage pool creation on Proxmox via Terraform using SSH local-exec.

## Overview

The `proxmox-zfs-pool` module can automatically create and configure ZFS pools on Proxmox by SSHing to the host and running `zpool` commands. This eliminates the need for manual pool creation.

## Prerequisites

- Proxmox VE installed and accessible
- SSH access to Proxmox node with key-based authentication
- Drives available for ZFS pool (not in use by other storage)

## Step 1: Identify Available Drives

SSH to your Proxmox node and list available block devices:

```bash
ssh root@172.16.100.250 lsblk -d -o NAME,SIZE,MODEL,SERIAL
```

Get stable device IDs (required for Terraform):

```bash
ssh root@172.16.100.250 ls -la /dev/disk/by-id/ | grep -v part
```

Example output:
```
nvme-Samsung_SSD_970_EVO_Plus_1TB_S4EWNX0N123456
nvme-Samsung_SSD_970_EVO_Plus_1TB_S4EWNX0N789012
```

## Step 2: Configure Terraform

Edit `/terragrunt/environments/homelab/proxmox-zfs-pool/terragrunt.hcl`:

```hcl
inputs = {
  # Enable ZFS pool creation
  create_zfs_pool = true
  zfs_pool_name   = "vm-storage"
  zfs_pool_type   = "mirror"  # or raidz1, raidz2, raidz3, stripe

  # Specify your actual device paths
  zfs_devices = [
    "/dev/disk/by-id/nvme-Samsung_SSD_970_EVO_Plus_1TB_S4EWNX0N123456",
    "/dev/disk/by-id/nvme-Samsung_SSD_970_EVO_Plus_1TB_S4EWNX0N789012",
  ]

  # ZFS properties
  zfs_ashift      = 12      # 12 for 4K, 13 for 8K sector drives
  zfs_compression = "lz4"
  zfs_atime       = "off"
  zfs_recordsize  = "128k"

  # Register as Proxmox storage
  create_storage_config = true
  storage_id            = "vm-storage"
}
```

## Step 3: Apply Terraform

```bash
cd terragrunt/environments/homelab/proxmox-zfs-pool
terragrunt plan
terragrunt apply
```

The module will:
1. Check if the pool already exists (skips creation if it does)
2. Create the ZFS pool with specified devices and type
3. Configure pool properties (compression, atime, recordsize)
4. Register the pool as Proxmox storage

## Pool Type Reference

| Type | Min Drives | Parity | Use Case |
|------|------------|--------|----------|
| `mirror` | 2 | 1:1 copy | High performance, max redundancy |
| `raidz1` | 3 | 1 drive | Balanced capacity/redundancy |
| `raidz2` | 4 | 2 drives | Higher redundancy |
| `raidz3` | 5 | 3 drives | Maximum redundancy |
| `stripe` | 1+ | None | Maximum performance, no redundancy |

## Verification

After applying, verify the pool:

```bash
# Check pool status
ssh root@172.16.100.250 zpool status vm-storage

# Check pool properties
ssh root@172.16.100.250 zfs get compression,atime,recordsize vm-storage

# Verify in Proxmox UI
# Datacenter → Storage → vm-storage should appear
```

## Troubleshooting

### SSH Connection Failed

```bash
# Test SSH connection
ssh -i ~/.ssh/id_ed25519 root@172.16.100.250 "echo 'SSH working'"

# Ensure key is authorized
ssh-copy-id -i ~/.ssh/id_ed25519 root@172.16.100.250
```

### Pool Already Exists

The module checks for existing pools and skips creation. To recreate:

```bash
# WARNING: This destroys all data!
ssh root@172.16.100.250 zpool destroy vm-storage

# Then re-run Terraform
terragrunt apply
```

### Drive In Use

If a drive is already in use:

```bash
# Check what's using the drive
ssh root@172.16.100.250 lsblk /dev/nvme0n1

# Wipe partition table (WARNING: destroys data)
ssh root@172.16.100.250 wipefs -a /dev/nvme0n1
```

### Wrong ashift Value

If you chose the wrong ashift, you must recreate the pool:

```bash
# Check current ashift
ssh root@172.16.100.250 zpool get ashift vm-storage

# Recreate with correct ashift (WARNING: destroys data)
ssh root@172.16.100.250 zpool destroy vm-storage
terragrunt apply
```

## Manual Creation (Alternative)

If you prefer manual creation:

```bash
# SSH to Proxmox
ssh root@172.16.100.250

# Create mirror pool
zpool create -f -o ashift=12 vm-storage mirror \
  /dev/disk/by-id/nvme-Samsung_SSD_970_EVO_Plus_1TB_XXX \
  /dev/disk/by-id/nvme-Samsung_SSD_970_EVO_Plus_1TB_YYY

# Configure properties
zfs set compression=lz4 vm-storage
zfs set atime=off vm-storage
zfs set recordsize=128k vm-storage
zfs set xattr=sa vm-storage
zfs set dnodesize=auto vm-storage
```

Then set `create_zfs_pool = false` in Terraform and only use `create_storage_config = true`.

## Reference

- [Proxmox ZFS Documentation](https://pve.proxmox.com/wiki/ZFS_on_Linux)
- [OpenZFS Administration](https://openzfs.github.io/openzfs-docs/)
