# Backport Notes - 2026-01-19

## Overview
This document records the backport of StorCLI package and HBA firmware configurations from the deployed Proxmox host (172.16.100.250) to the Ansible infrastructure-as-code repository. The backport ensures that the deployed state is accurately reflected in the Ansible configuration for future deployments and updates.

## Summary of Findings

### 1. Fan Threshold Configuration ✓
**Status**: Configuration matches, no changes required

The current systemd service on the target host matches the Ansible template exactly. However, during the review, we discovered:

- **Legacy Script Found**: `/etc/init.d/set_fan_threshold.sh` - An old init.d script that predates the systemd service
- **Security Risk**: The legacy script contains hardcoded IPMI credentials in plaintext
- **Action Taken**: Added cleanup task to IPMI role to remove legacy script

**Files Extracted for Reference**:
- `docs/reference-configs/legacy-fan-threshold-initd.sh` - Legacy init.d script (for audit trail)
- `docs/reference-configs/deployed-fan-threshold.service` - Current systemd service
- `docs/reference-configs/fan-sensors-state.txt` - Current IPMI sensor state

### 2. StorCLI Package Version Mismatch
**Status**: Resolved

**Target Host Version**: 007.2705.0000.0000 (August 24, 2023)
**Ansible Expected Version**: 007.0327.0000.0000 (placeholder only)

**Actions Taken**:
1. Installed `dpkg-repack` on target host
2. Repacked the installed StorCLI package: `storcli_007.2705.0000.0000_all.deb`
3. Copied package to `ansible/files/storcli_007.2705.0000.0000_all.deb`
4. Removed old placeholder file
5. Updated `ansible/inventory/group_vars/proxmox.yml` to reference new version

**Package Details**:
- File: `storcli_007.2705.0000.0000_all.deb`
- MD5: `64a91ca40d603506d6a7a7fe3be4e90b`
- Location: `ansible/files/`

### 3. HBA Firmware Package Discovery
**Status**: Complete firmware package extracted

Discovered complete firmware package in `/root/firmware_p24/` on target host.

**Firmware Details**:
- **Firmware Version**: P24 (24.00.00.00)
- **Release Date**: July 25, 2022
- **BIOS Version**: 09.47.00.00 (July 9, 2022)
- **Controller**: Broadcom 9400-8i HBA
- **Total Package Size**: 4.8MB

**Firmware Profiles Available**:
1. `HBA_9400-8i_Mixed_Profile.bin` (1.8MB)
   - MD5: `00e2d9d924debd9f700091599bfe6684`
   - Supports: SAS, SATA, and NVMe drives

2. `HBA_9400-8i_SAS_SATA_Profile.bin` (1.8MB)
   - MD5: `ec54b398d070ae708f1f4254ab91eba0`
   - Supports: SAS and SATA drives only

**Current Controller State** (Both Cards):
- Firmware Version: 24.00.00.00 (already running P24)
- BIOS Version: 09.47.00.00_02.00.00.00
- Controllers: Broadcom 9400-8i HBA (Card 0 and Card 1)

**Actions Taken**:
1. Downloaded complete firmware package to `ansible/files/firmware/hba_9400-8i/`
2. Verified firmware file checksums (MD5 matches)
3. Added firmware configuration variables to Ansible
4. Enhanced StorCLI role with firmware flashing capability

## Changes Made to Ansible

### Configuration Files

#### 1. `ansible/inventory/group_vars/proxmox.yml`

**Line 26 - Updated StorCLI Package Path**:
```yaml
# Before:
storcli_package_path: "{{ playbook_dir }}/../files/storcli_007.0327.0000.0000_all.deb"

# After:
storcli_package_path: "{{ playbook_dir }}/../files/storcli_007.2705.0000.0000_all.deb"
```

**Lines 29-34 - Added HBA Firmware Configuration**:
```yaml
# HBA Firmware Configuration (Phase 24)
storcli_firmware_update: true  # Enabled by default - will be no-op if same version already installed
storcli_firmware_package_dir: "{{ playbook_dir }}/../files/firmware/hba_9400-8i/9400_8i_Pkg_P24_SAS_SATA_NVMe_FW_BIOS_UEFI"
storcli_firmware_profile: "Mixed_Profile"  # Supports SAS, SATA, and NVMe drives
storcli_firmware_version: "24.00.00.00"
storcli_bios_version: "09.47.00.00"
```

### Role Updates

#### 2. `ansible/roles/proxmox-storcli/tasks/main.yml`

**Added Symlink** (after line 48):
```yaml
- name: Create additional StorCLI symlink (storcli without version)
  ansible.builtin.file:
    src: "{{ storcli_binary }}"
    dest: /usr/local/bin/storcli
    state: link
    force: true
```

**Enhanced Firmware Flashing** (replaced lines 85-124):
- Added current firmware version checking
- Updated to use `.bin` firmware files instead of `.rom`
- Added firmware flash result display for better debugging
- Added reboot prompt when firmware is updated
- Improved error handling for "already running same firmware" case
- Made firmware flashing idempotent

#### 3. `ansible/roles/proxmox-ipmi/tasks/main.yml`

**Added Legacy Cleanup** (after line 135):
```yaml
- name: Remove legacy init.d fan threshold script
  ansible.builtin.file:
    path: /etc/init.d/set_fan_threshold.sh
    state: absent
  register: legacy_script_removed

- name: Display legacy script cleanup status
  ansible.builtin.debug:
    msg: "Legacy init.d script {{ 'removed' if legacy_script_removed.changed else 'not found' }}"
```

## Security Improvements

### Hardcoded Credentials Removed
The legacy init.d script (`/etc/init.d/set_fan_threshold.sh`) contained hardcoded IPMI credentials:
```bash
# Legacy script (INSECURE):
IPMI_USER="ADMIN"
IPMI_PASSWORD="ADMIN"
```

**Mitigation**:
- Added cleanup task to remove legacy script
- Current systemd service uses Ansible vault for secrets management
- No plaintext credentials in production configuration

## Firmware Flashing Strategy

### Default Configuration
- **Firmware Update Enabled**: `true` (by default)
- **Profile**: `Mixed_Profile` (supports SAS/SATA + NVMe)
- **Safety**: Since target already runs P24, first execution will be idempotent (no-op)

### Behavior
1. Checks current firmware version
2. Copies firmware package to target if update enabled
3. Attempts firmware flash
4. Detects if "already running same firmware" (expected on first run)
5. Cleans up temporary firmware file
6. Prompts for reboot if firmware was actually updated

### To Disable Firmware Updates
Set in `proxmox.yml`:
```yaml
storcli_firmware_update: false
```

## Files Extracted from Target

### StorCLI Package
- Source: `/root/storcli_007.2705.0000.0000_all.deb` (created via dpkg-repack)
- Destination: `ansible/files/storcli_007.2705.0000.0000_all.deb`
- MD5: `64a91ca40d603506d6a7a7fe3be4e90b`

### Firmware Package
- Source: `/root/firmware_p24/9400_8i_Pkg_P24_SAS_SATA_NVMe_FW_BIOS_UEFI/`
- Destination: `ansible/files/firmware/hba_9400-8i/9400_8i_Pkg_P24_SAS_SATA_NVMe_FW_BIOS_UEFI/`
- Size: 4.8MB (complete package with docs, BIOS, UEFI, and firmware profiles)

### Reference Configurations
- `docs/reference-configs/legacy-fan-threshold-initd.sh` - Legacy init.d script
- `docs/reference-configs/deployed-fan-threshold.service` - Current systemd service
- `docs/reference-configs/fan-sensors-state.txt` - IPMI sensor state snapshot

## Verification Steps Completed

### Phase 1: File Extraction ✓
- [x] StorCLI package repacked and copied
- [x] Firmware package downloaded and checksums verified
- [x] Reference configurations extracted

### Phase 2: Ansible Updates ✓
- [x] StorCLI variables updated in proxmox.yml
- [x] StorCLI role enhanced with symlink and firmware flashing
- [x] IPMI role updated with legacy cleanup task

### Phase 3: Documentation ✓
- [x] Backport notes created (this document)
- [x] HBA firmware flashing runbook created
- [x] Ansible README updated

## Next Steps

### 1. Testing (Phase 4)
Run Ansible playbooks in check mode to verify changes:
```bash
cd ansible
ansible-playbook playbooks/proxmox-storcli.yml --check --diff
ansible-playbook playbooks/proxmox-ipmi-fans.yml --check --diff
```

### 2. Deployment
Apply changes to target host:
```bash
ansible-playbook playbooks/site.yml
# Or individually:
ansible-playbook playbooks/proxmox-storcli.yml
ansible-playbook playbooks/proxmox-ipmi-fans.yml
```

### 3. Verification
Verify changes on target host:
```bash
# Verify StorCLI symlinks
ssh root@172.16.100.250 "ls -la /usr/local/bin/storcli*"

# Verify firmware version
ssh root@172.16.100.250 "storcli64 /c0 show all | grep -i firmware"

# Verify legacy cleanup
ssh root@172.16.100.250 "test -f /etc/init.d/set_fan_threshold.sh && echo 'LEGACY STILL EXISTS' || echo 'Cleaned up'"
```

## Risk Assessment

### Low Risk ✓
- StorCLI package update (newer version, backward compatible)
- Additional symlink creation (non-breaking)
- Legacy script removal (already superseded by systemd)

### Low Risk (User Confirmed) ✓
- **Firmware flashing enabled by default**: Safe because:
  - Controllers already running P24 firmware
  - Will be idempotent (detects "already running same firmware")
  - Proper error handling prevents failures
  - Reboot prompt only shown if firmware actually changes

## Success Criteria

- [x] StorCLI .deb package (version 007.2705.0000.0000) in ansible/files/
- [x] HBA firmware package P24 in ansible/files/firmware/
- [x] Ansible variables updated to reference correct versions
- [x] StorCLI role creates both `storcli` and `storcli64` symlinks
- [x] IPMI role removes legacy init.d script
- [x] Firmware flashing capability added to StorCLI role
- [x] Firmware checksums verified (MD5)
- [x] Documentation created
- [ ] Playbooks run successfully in check mode (pending)
- [ ] All verification commands pass on target host (pending)

## Notes

- Target host already runs firmware P24, so firmware flashing will be a no-op on first run
- Firmware update enabled by default per user preference (safe due to idempotency)
- Complete firmware package preserved including documentation and release notes
- Legacy init.d script removed to eliminate security risk (hardcoded credentials)
- All changes maintain idempotency - safe to re-run playbooks

## Related Documentation

- See: `docs/runbooks/hba-firmware-update.md` for firmware flashing procedures
- See: `ansible/README.md` for updated StorCLI and firmware management documentation
- See: `docs/reference-configs/` for extracted configuration snapshots
