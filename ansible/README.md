# Ansible Configuration for Proxmox

This directory contains Ansible playbooks and roles for Phase 2: Proxmox Configuration as defined in the homelab project plan.

## Overview

The Ansible automation handles the following tasks:
- **Post-installation configuration** - Executes community scripts and installs essential packages
- **StorCLI installation** - Installs Broadcom StorCLI for HBA management and firmware updates
- **IPMI fan threshold configuration** - Fixes Noctua fan cyclical spin-up on Supermicro motherboards
- **Network configuration** - Configures VLAN-aware bridge for VM networking

## Prerequisites

1. **Proxmox installed** - Phase 1 must be completed (Proxmox accessible on your network)

2. **SSH public key authentication configured** - Root SSH access to Proxmox host with public key authentication:

   ```bash
   # Generate SSH key if you don't have one
   ssh-keygen -t ed25519 -C "your_email@example.com"

   # Copy your public key to the Proxmox host (replace ${PROXMOX_HOST} with your Proxmox IP)
   ssh-copy-id root@${PROXMOX_HOST}

   # Test the connection (should not prompt for password)
   ssh root@${PROXMOX_HOST}
   ```

   **Note**: You'll need the root password when running `ssh-copy-id`. After setup, Ansible will authenticate using your SSH key. The Proxmox host IP is configured in `inventory/hosts.yml` (default: 172.16.100.250).

3. **Ansible installed** - Managed automatically via mise (see project root README), or install manually:
   ```bash
   # Ubuntu/Debian
   sudo apt install ansible

   # macOS
   brew install ansible

   # Or via pip
   pip install ansible
   ```

4. **StorCLI package** - Version 007.2705.0000.0000 included in repository (extracted from deployed host)

## Directory Structure

```
ansible/
├── ansible.cfg                          # Ansible configuration
├── requirements.yml                     # Ansible Galaxy dependencies
├── inventory/
│   ├── hosts.yml                        # Proxmox host inventory
│   └── group_vars/
│       ├── all.yml                      # Global variables
│       └── proxmox.yml                  # Proxmox-specific variables
├── playbooks/
│   ├── site.yml                         # Main playbook (entry point)
│   ├── proxmox-post-install.yml         # Post-installation tasks
│   ├── proxmox-storcli.yml              # StorCLI installation
│   ├── proxmox-ipmi-fans.yml            # IPMI fan configuration
│   └── proxmox-networking.yml           # Network bridge configuration
├── roles/
│   ├── proxmox-base/                    # Base Proxmox configuration
│   ├── proxmox-storcli/                 # StorCLI management
│   ├── proxmox-ipmi/                    # IPMI configuration
│   └── proxmox-networking/              # Network configuration
└── files/
    ├── storcli_007.2705.0000.0000_all.deb  # StorCLI package
    └── firmware/
        └── hba_9400-8i/                 # HBA firmware packages
```

## Quick Start

### 1. Install Ansible Dependencies

```bash
cd ansible
ansible-galaxy install -r requirements.yml
```

### 2. Configure Inventory

Edit `inventory/hosts.yml` and update the following:
- `ansible_host` - IP address of your Proxmox host
- PCI IDs for HBA cards and GPU (if different)
- Storage device paths (if different)

### 3. Configure Variables

Review and update variables in:
- `inventory/group_vars/all.yml` - Global settings (timezone, domain, etc.)
- `inventory/group_vars/proxmox.yml` - Proxmox-specific settings

**Important variables to review:**
- `ipmi_fan_thresholds` - Fan threshold values (adjust for your fans)
- `storcli_firmware_update` - Enable/disable HBA firmware flashing (enabled by default)
- `storcli_firmware_profile` - Firmware profile: "Mixed_Profile" (SAS/SATA/NVMe) or "SAS_SATA_Profile"
- `zfs_pool_*` - ZFS pool configuration

### 4. Test Connectivity

```bash
ansible proxmox -m ping
```

Expected output:
```
pve01 | SUCCESS => {
    "changed": false,
    "ping": "pong"
}
```

### 5. Run Playbooks

#### Run all configuration (recommended)
```bash
ansible-playbook playbooks/site.yml
```

#### Run individual playbooks
```bash
# Post-installation only
ansible-playbook playbooks/proxmox-post-install.yml

# IPMI fan configuration only
ansible-playbook playbooks/proxmox-ipmi-fans.yml

# StorCLI installation only
ansible-playbook playbooks/proxmox-storcli.yml

# Network configuration only
ansible-playbook playbooks/proxmox-networking.yml
```

### 6. Verify Configuration

After running the playbooks, verify:

```bash
# Check Proxmox version
ssh root@172.16.100.250 'pveversion'

# Check StorCLI installation
ssh root@172.16.100.250 'storcli64 show'

# Check fan sensors
ssh root@172.16.100.250 'ipmitool sensor list | grep -i fan'

# Check network bridge
ssh root@172.16.100.250 'brctl show'
```

## Playbook Details

### site.yml (Main Entry Point)

The main playbook that orchestrates all configuration tasks. It runs playbooks in the correct order:
1. Post-installation configuration
2. IPMI fan threshold configuration
3. StorCLI installation (if package available)
4. Network configuration

### proxmox-post-install.yml

Executes the Proxmox community post-install script and installs essential packages.

**What it does:**
- Disables enterprise repository (if not licensed)
- Adds no-subscription repository
- Installs essential packages (htop, iotop, vim, ipmitool, etc.)
- Configures timezone
- Updates system (if `apt_upgrade: true`)

**Idempotency:** Safe to run multiple times

### proxmox-storcli.yml

Installs Broadcom StorCLI for HBA management and manages HBA firmware updates.

**What it does:**
- Installs StorCLI .deb package (version 007.2705.0000.0000)
- Creates symlinks in `/usr/local/bin` (`storcli` and `storcli64`)
- Checks current firmware version
- Optionally flashes HBA firmware (enabled by default)
- Displays HBA controller information
- Creates health monitoring cron job

**Idempotency:** Safe to run multiple times. Firmware flashing detects "already running same firmware" and skips update.

**Firmware Update:**
- Default: Enabled (`storcli_firmware_update: true`)
- Firmware: P24 (24.00.00.00)
- Profile: Mixed_Profile (supports SAS/SATA/NVMe drives)
- Reboot required after firmware update to activate new firmware
- See `docs/runbooks/hba-firmware-update.md` for detailed firmware procedures

### proxmox-ipmi-fans.yml

Configures IPMI fan thresholds to fix Noctua fan cyclical spin-up issue.

**What it does:**
- Installs ipmitool
- Configures fan thresholds for Noctua fans (lower RPM thresholds)
- Creates systemd service to apply thresholds on boot
- Creates monitoring script that logs fan speeds
- Removes legacy init.d script (security cleanup - removes hardcoded credentials)

**Idempotency:** Safe to run multiple times

**Reference:** https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/

### proxmox-networking.yml

Configures Proxmox network bridge with VLAN awareness.

**What it does:**
- Enables VLAN support (8021q kernel module)
- Configures bridge as VLAN-aware
- Sets MTU (default: 1500)
- Creates network diagnostics script

**Idempotency:** Safe to run multiple times

**Warning:** Network configuration changes may require a reboot

## HBA Firmware Management

### Overview
The `proxmox-storcli` role includes comprehensive HBA firmware management capabilities for Broadcom 9400-8i controllers. Firmware flashing is enabled by default and is fully idempotent.

### Current Configuration
- **Firmware Version**: P24 (24.00.00.00) - Released July 25, 2022
- **BIOS Version**: 09.47.00.00
- **Profile**: Mixed_Profile (supports SAS, SATA, and NVMe drives)
- **Controllers**: 2x Broadcom 9400-8i HBA (Card 0 and Card 1)

### Firmware Profiles

#### Mixed Profile (Default)
**File**: `HBA_9400-8i_Mixed_Profile.bin`
**Supports**: SAS, SATA, and NVMe drives
**Use Case**: General purpose - recommended for most deployments

#### SAS/SATA Profile
**File**: `HBA_9400-8i_SAS_SATA_Profile.bin`
**Supports**: SAS and SATA drives only
**Use Case**: Systems without NVMe drives

### Firmware Update Procedure

1. **Verify Configuration** in `inventory/group_vars/proxmox.yml`:
   ```yaml
   storcli_firmware_update: true  # Enabled by default
   storcli_firmware_profile: "Mixed_Profile"
   ```

2. **Run Playbook**:
   ```bash
   ansible-playbook playbooks/proxmox-storcli.yml
   ```

3. **Reboot System** (if firmware was updated):
   ```bash
   ansible-playbook playbooks/reboot.yml
   # Or manually:
   ssh root@172.16.100.250 "reboot"
   ```

4. **Verify Update**:
   ```bash
   ssh root@172.16.100.250 "storcli64 /c0 show all | grep -i firmware"
   ```

### Safety Features
- **Idempotent**: Detects "already running same firmware" and skips unnecessary updates
- **Error Handling**: Fails gracefully if firmware is already current
- **Reboot Prompt**: Notifies when reboot is required
- **Version Check**: Displays current firmware before attempting update

### Additional Resources
For detailed firmware update procedures, troubleshooting, and rollback instructions, see:
- `docs/runbooks/hba-firmware-update.md` - Complete firmware management runbook
- `docs/backport-notes-2026-01-19.md` - Implementation details and security notes

## Variables

### Global Variables (all.yml)

| Variable | Default | Description |
|----------|---------|-------------|
| `base_domain` | ryanmcafee.com | Base domain for homelab |
| `homelab_vlan` | 100 | VLAN ID for homelab network |
| `homelab_subnet` | 172.16.100.0/24 | Homelab subnet |
| `homelab_gateway` | 172.16.100.1 | Default gateway |
| `timezone` | America/New_York | System timezone |

### Proxmox Variables (proxmox.yml)

| Variable | Default | Description |
|----------|---------|-------------|
| `proxmox_enterprise` | false | Use enterprise repositories |
| `storcli_package_path` | [path] | Path to StorCLI .deb package |
| `storcli_firmware_update` | true | Enable HBA firmware flashing |
| `storcli_firmware_profile` | Mixed_Profile | Firmware profile (Mixed_Profile or SAS_SATA_Profile) |
| `storcli_firmware_version` | 24.00.00.00 | Target firmware version (P24) |
| `storcli_bios_version` | 09.47.00.00 | Target BIOS version |
| `ipmi_fan_thresholds` | [list] | Fan threshold configuration |
| `zfs_pool_name` | vm-storage | ZFS pool name |
| `proxmox_mtu` | 1500 | Network MTU |

### Host Variables (hosts.yml)

| Variable | Required | Description |
|----------|----------|-------------|
| `ansible_host` | Yes | Proxmox IP address |
| `ipmi_host` | Yes | IPMI IP address |
| `ipmi_user` | Yes | IPMI username |
| `hba_card_1_pci_id` | No | HBA Card 1 PCI ID |
| `hba_card_2_pci_id` | No | HBA Card 2 PCI ID |
| `gpu_pci_id` | No | GPU PCI ID |

## Troubleshooting

### SSH Connection Issues

```bash
# Test SSH connectivity
ssh -v root@172.16.100.250

# If host key verification fails
ssh-keygen -R 172.16.100.250
```

### Ansible Fails with "permission denied"

Ensure you have root access:
```bash
ansible proxmox -m command -a 'whoami'
```

### StorCLI Package Not Found

Download the package from Broadcom and place it in `ansible/files/`:
```bash
ls -la ansible/files/storcli_*.deb
```

### IPMI Not Accessible

Verify IPMI network connectivity:
```bash
ping 172.16.100.26
```

### Network Configuration Changes Not Applied

Network changes may require a reboot:
```bash
ssh root@172.16.100.250 'reboot'
```

### HBA Firmware Issues

#### "Already running the same firmware"
This is expected behavior when the target firmware is already installed. No action needed.

#### Firmware flash fails with permission error
Ensure StorCLI is installed and accessible:
```bash
ssh root@172.16.100.250 'which storcli64'
ssh root@172.16.100.250 'storcli64 show'
```

#### Controller not detected
Verify HBA is properly seated and detected:
```bash
ssh root@172.16.100.250 'lspci | grep -i sas'
```

#### Firmware version doesn't change after flash
A reboot is required to activate new firmware:
```bash
ansible-playbook playbooks/reboot.yml
```

For detailed firmware troubleshooting, see `docs/runbooks/hba-firmware-update.md`

### Check Ansible Logs

Ansible logs are stored in `/var/log/ansible/` on the Proxmox host:
```bash
ssh root@172.16.100.250 'ls -la /var/log/ansible/'
```

## Development

### Testing Playbooks

Use check mode to test without making changes:
```bash
ansible-playbook playbooks/site.yml --check
```

### Limiting Execution

Run playbook on specific host:
```bash
ansible-playbook playbooks/site.yml --limit pve01
```

### Verbose Output

Increase verbosity for debugging:
```bash
ansible-playbook playbooks/site.yml -v    # Verbose
ansible-playbook playbooks/site.yml -vv   # More verbose
ansible-playbook playbooks/site.yml -vvv  # Very verbose
```

### Tags

(Future enhancement - add tags to tasks for selective execution)

## Integration with Project Plan

This Ansible configuration implements **Phase 2: Proxmox Configuration** from `plan.md`.

**Dependencies:**
- Phase 1 (Proxmox Installation) must be completed first

**Next Phase:**
- Phase 3 (Infrastructure Provisioning) uses Terragrunt to provision VMs

## References

### External Documentation
- [Proxmox Community Scripts](https://github.com/community-scripts/ProxmoxVE)
- [Broadcom 9400-8i Documentation](https://docs.broadcom.com/doc/12354774)
- [IPMI Fan Threshold Configuration](https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/)
- [Ansible Documentation](https://docs.ansible.com/)

### Project Documentation
- `docs/runbooks/hba-firmware-update.md` - HBA firmware update procedures
- `docs/backport-notes-2026-01-19.md` - StorCLI and firmware backport implementation notes
- `docs/reference-configs/` - Reference configurations extracted from deployed host

## Support

For issues specific to this configuration:
1. Check the troubleshooting section above
2. Review playbook output for error messages
3. Check Proxmox logs: `/var/log/pve/`
4. Review Ansible facts: `ansible proxmox -m setup`

## License

This configuration is part of the homelab project and follows the project's license.
