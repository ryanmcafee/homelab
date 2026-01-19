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

4. **StorCLI package** - Download from Broadcom (see files/storcli_*.placeholder)

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
    └── storcli_*.deb                    # StorCLI package (must download)
```

## Quick Start

### 1. Install Ansible Dependencies

```bash
cd ansible
ansible-galaxy install -r requirements.yml
```

### 2. Download StorCLI Package

Follow instructions in `files/storcli_007.0327.0000.0000_all.deb.placeholder` to download the StorCLI package from Broadcom.

### 3. Configure Inventory

Edit `inventory/hosts.yml` and update the following:
- `ansible_host` - IP address of your Proxmox host
- PCI IDs for HBA cards and GPU (if different)
- Storage device paths (if different)

### 4. Configure Variables

Review and update variables in:
- `inventory/group_vars/all.yml` - Global settings (timezone, domain, etc.)
- `inventory/group_vars/proxmox.yml` - Proxmox-specific settings

**Important variables to review:**
- `ipmi_fan_thresholds` - Fan threshold values (adjust for your fans)
- `storcli_firmware_update` - Set to `true` to flash HBA firmware
- `zfs_pool_*` - ZFS pool configuration

### 5. Test Connectivity

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

### 6. Run Playbooks

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

### 7. Verify Configuration

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

Installs Broadcom StorCLI for HBA management and optionally flashes firmware.

**What it does:**
- Installs StorCLI .deb package
- Creates symlink in `/usr/local/bin`
- Displays HBA controller information
- Optionally flashes HBA firmware (if `storcli_firmware_update: true`)
- Creates health monitoring cron job

**Idempotency:** Safe to run multiple times

**Firmware Update:** Set `storcli_firmware_update: true` and provide `storcli_firmware_path` to flash firmware

### proxmox-ipmi-fans.yml

Configures IPMI fan thresholds to fix Noctua fan cyclical spin-up issue.

**What it does:**
- Installs ipmitool
- Configures fan thresholds for Noctua fans (lower RPM thresholds)
- Creates systemd service to apply thresholds on boot
- Creates monitoring script that logs fan speeds

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
| `storcli_firmware_update` | false | Flash HBA firmware |
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

- [Proxmox Community Scripts](https://github.com/community-scripts/ProxmoxVE)
- [Broadcom 9400-8i Documentation](https://docs.broadcom.com/doc/12354774)
- [IPMI Fan Threshold Configuration](https://calvin.me/quick-how-to-decrease-ipmi-fan-threshold/)
- [Ansible Documentation](https://docs.ansible.com/)

## Support

For issues specific to this configuration:
1. Check the troubleshooting section above
2. Review playbook output for error messages
3. Check Proxmox logs: `/var/log/pve/`
4. Review Ansible facts: `ansible proxmox -m setup`

## License

This configuration is part of the homelab project and follows the project's license.
