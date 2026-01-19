# HBA Firmware Update Runbook

## Overview
This runbook provides step-by-step instructions for updating Broadcom 9400-8i HBA firmware using the Ansible StorCLI role. The firmware flashing capability is integrated into the `proxmox-storcli` role and can be enabled/disabled via configuration variables.

## Prerequisites

### Required Components
- [x] StorCLI installed on target host (via `proxmox-storcli` role)
- [x] Firmware package available in `ansible/files/firmware/hba_9400-8i/`
- [x] Ansible vault credentials configured (for remote access)
- [x] SSH access to target Proxmox host

### Current System State
- **Controller Type**: Broadcom 9400-8i HBA
- **Number of Controllers**: 2 (Card 0 and Card 1)
- **Current Firmware**: P24 (24.00.00.00)
- **Current BIOS**: 09.47.00.00_02.00.00.00

## Firmware Package Details

### Available Firmware Profiles

#### 1. Mixed Profile (Recommended)
**File**: `HBA_9400-8i_Mixed_Profile.bin`
**MD5**: `00e2d9d924debd9f700091599bfe6684`
**Supports**: SAS, SATA, and NVMe drives
**Use Case**: General purpose - supports all drive types

#### 2. SAS/SATA Profile
**File**: `HBA_9400-8i_SAS_SATA_Profile.bin`
**MD5**: `ec54b398d070ae708f1f4254ab91eba0`
**Supports**: SAS and SATA drives only
**Use Case**: Systems without NVMe drives

### Firmware Version
- **Version**: P24 (24.00.00.00)
- **Release Date**: July 25, 2022
- **Package Location**: `ansible/files/firmware/hba_9400-8i/9400_8i_Pkg_P24_SAS_SATA_NVMe_FW_BIOS_UEFI/`

## Configuration

### Enable Firmware Updates

Edit `ansible/inventory/group_vars/proxmox.yml`:

```yaml
# HBA Firmware Configuration (Phase 24)
storcli_firmware_update: true  # Set to true to enable firmware flashing
storcli_firmware_package_dir: "{{ playbook_dir }}/../files/firmware/hba_9400-8i/9400_8i_Pkg_P24_SAS_SATA_NVMe_FW_BIOS_UEFI"
storcli_firmware_profile: "Mixed_Profile"  # or "SAS_SATA_Profile"
storcli_firmware_version: "24.00.00.00"
storcli_bios_version: "09.47.00.00"
```

### Disable Firmware Updates

```yaml
storcli_firmware_update: false  # Firmware flashing will be skipped
```

## Procedure

### Step 1: Pre-Flight Checks

#### Check Current Firmware Version
```bash
ssh root@172.16.100.250 "storcli64 /c0 show all | grep -i 'firmware version'"
ssh root@172.16.100.250 "storcli64 /c1 show all | grep -i 'firmware version'"
```

Expected output:
```
Firmware Version = 24.00.00.00
```

#### Verify Firmware Package Availability
```bash
ls -lh ansible/files/firmware/hba_9400-8i/9400_8i_Pkg_P24_SAS_SATA_NVMe_FW_BIOS_UEFI/Firmware/
```

Expected output:
```
HBA_9400-8i_Mixed_Profile.bin
HBA_9400-8i_SAS_SATA_Profile.bin
```

#### Verify Firmware Checksums
```bash
cd ansible/files/firmware/hba_9400-8i/9400_8i_Pkg_P24_SAS_SATA_NVMe_FW_BIOS_UEFI/Firmware
md5sum HBA_9400-8i_Mixed_Profile.bin
md5sum HBA_9400-8i_SAS_SATA_Profile.bin
```

Expected checksums:
```
00e2d9d924debd9f700091599bfe6684  HBA_9400-8i_Mixed_Profile.bin
ec54b398d070ae708f1f4254ab91eba0  HBA_9400-8i_SAS_SATA_Profile.bin
```

### Step 2: Run Ansible Playbook in Check Mode

Test the playbook without making changes:
```bash
cd ansible
ansible-playbook playbooks/proxmox-storcli.yml --check --diff
```

Review the output for any errors or warnings.

### Step 3: Execute Firmware Update

Run the playbook to perform the firmware update:
```bash
ansible-playbook playbooks/proxmox-storcli.yml
```

### Step 4: Monitor Output

Watch for the following task outputs:

#### Firmware Version Check
```
TASK [proxmox-storcli : Check current firmware version]
ok: [proxmox-host]
```

#### Firmware Copy
```
TASK [proxmox-storcli : Copy firmware package if firmware update is enabled]
changed: [proxmox-host]  # If firmware package copied
```

#### Firmware Flash (Card 0)
```
TASK [proxmox-storcli : Flash HBA firmware (Card 0)]
changed: [proxmox-host]  # If firmware updated
ok: [proxmox-host]       # If already running same firmware
```

#### Firmware Flash (Card 1)
```
TASK [proxmox-storcli : Flash HBA firmware (Card 1)]
changed: [proxmox-host]  # If firmware updated
ok: [proxmox-host]       # If already running same firmware
```

#### Reboot Prompt
If firmware was flashed, you'll see:
```
TASK [proxmox-storcli : Prompt for reboot if firmware was flashed]
ok: [proxmox-host] => {
    "msg": "IMPORTANT: System reboot required to activate new firmware. Run: ansible-playbook playbooks/reboot.yml"
}
```

### Step 5: Reboot (If Required)

If firmware was updated (changed status), reboot the system:

```bash
# Using Ansible (recommended)
ansible-playbook playbooks/reboot.yml

# Or manually
ssh root@172.16.100.250 "reboot"
```

**IMPORTANT**: Wait for system to fully boot before proceeding to verification.

### Step 6: Post-Update Verification

#### Verify New Firmware Version
```bash
ssh root@172.16.100.250 "storcli64 /c0 show all | grep -i 'firmware version'"
ssh root@172.16.100.250 "storcli64 /c1 show all | grep -i 'firmware version'"
```

#### Verify BIOS Version
```bash
ssh root@172.16.100.250 "storcli64 /c0 show all | grep -i 'bios version'"
ssh root@172.16.100.250 "storcli64 /c1 show all | grep -i 'bios version'"
```

#### Check Controller Status
```bash
ssh root@172.16.100.250 "storcli64 /c0 show all"
ssh root@172.16.100.250 "storcli64 /c1 show all"
```

Verify:
- Controller is healthy (Status: Optimal)
- All drives are detected
- No error messages in controller log

#### Test Drive Access
If using ZFS pools or VMs on these controllers:
```bash
# Check ZFS pool status
ssh root@172.16.100.250 "zpool status"

# Check VM storage
ssh root@172.16.100.250 "pvesm status"
```

## Expected Outcomes

### Scenario 1: Already Running Target Firmware
If the controller is already running the target firmware version:

**Task Status**: `ok` (not changed)
**Output**: Contains "already running the same firmware"
**Action Required**: None - system is already up to date

### Scenario 2: Firmware Updated Successfully
If firmware was flashed to a new version:

**Task Status**: `changed`
**Output**: Contains "Firmware download successful"
**Action Required**: Reboot system to activate new firmware

### Scenario 3: Firmware Flash Failed
If firmware flashing encounters an error:

**Task Status**: `failed`
**Output**: Contains error message
**Action Required**: Review error, troubleshoot, and retry

## Troubleshooting

### Issue: "already running the same firmware"

**Cause**: Controller is already running the target firmware version
**Resolution**: This is expected behavior - no action needed
**Note**: This is an idempotent operation - safe to run multiple times

### Issue: "Controller not found"

**Cause**: StorCLI cannot detect the HBA controller
**Resolution**:
1. Verify controller is properly seated
2. Check BIOS detects the controller
3. Verify StorCLI is correctly installed: `storcli64 show`

### Issue: Firmware file not found

**Cause**: Firmware package not available on target host
**Resolution**:
1. Verify firmware package in `ansible/files/firmware/hba_9400-8i/`
2. Check `storcli_firmware_package_dir` variable in `proxmox.yml`
3. Verify `storcli_firmware_profile` matches available `.bin` files

### Issue: Permission denied during flash

**Cause**: Insufficient permissions or device busy
**Resolution**:
1. Ensure running as root
2. Check no other processes accessing the controller
3. Verify StorCLI binary has execute permissions

### Issue: System won't boot after firmware update

**Cause**: Firmware incompatibility or corruption
**Resolution**:
1. Boot from rescue media
2. Access BIOS/UEFI firmware
3. Flash previous firmware version manually
4. Contact Broadcom support if persistent

## Rollback Procedure

### To Revert to Previous Firmware

If you need to roll back to a previous firmware version:

1. **Obtain Previous Firmware Package**:
   - Download from Broadcom support site
   - Or restore from backup

2. **Update Ansible Configuration**:
   ```yaml
   storcli_firmware_package_dir: "{{ playbook_dir }}/../files/firmware/hba_9400-8i/PREVIOUS_VERSION"
   storcli_firmware_version: "XX.XX.XX.XX"  # Previous version
   ```

3. **Run Firmware Update**:
   ```bash
   ansible-playbook playbooks/proxmox-storcli.yml
   ```

4. **Reboot System**:
   ```bash
   ansible-playbook playbooks/reboot.yml
   ```

5. **Verify Rollback**:
   ```bash
   ssh root@172.16.100.250 "storcli64 /c0 show all | grep -i firmware"
   ```

## Safety Notes

### Data Safety
- **BACKUP DATA**: Always backup critical data before firmware updates
- **Live Systems**: Firmware can be flashed on live systems, but reboot required to activate
- **Drive Access**: Drives remain accessible during firmware flash (no interruption)

### Idempotency
- Safe to run firmware update multiple times
- Will detect "already running same firmware" and skip unnecessary flashing
- No risk of "double-flashing" or corruption from multiple runs

### Reboot Requirement
- Firmware updates **REQUIRE** system reboot to activate
- Running firmware version won't change until after reboot
- Plan reboot window accordingly for production systems

### Compatibility
- Verify firmware version is compatible with your controller model
- Wrong firmware can brick the controller
- Always verify controller model: `storcli64 /c0 show all | grep -i 'product name'`

## Reference Commands

### Check StorCLI Version
```bash
storcli64 -v
```

### List All Controllers
```bash
storcli64 show
```

### Get Controller Details
```bash
storcli64 /c0 show all
storcli64 /c1 show all
```

### Get Firmware Version Only
```bash
storcli64 /c0 show all | grep -i 'firmware version'
```

### Get BIOS Version Only
```bash
storcli64 /c0 show all | grep -i 'bios version'
```

### Manual Firmware Flash (if needed)
```bash
# Card 0
storcli64 /c0 download file=/path/to/firmware.bin

# Card 1
storcli64 /c1 download file=/path/to/firmware.bin
```

## Related Documentation

- **Backport Notes**: See `docs/backport-notes-2026-01-19.md` for implementation details
- **Ansible README**: See `ansible/README.md` for role configuration
- **Broadcom Documentation**: Included in firmware package under `Documentation/` directory
- **Release Notes**: `firmware/hba_9400-8i/.../Documentation/*.pdf`

## Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-19 | 1.0 | Initial runbook creation - P24 firmware backport |

## Support

For issues or questions:
1. Review this runbook
2. Check `docs/backport-notes-2026-01-19.md`
3. Consult Broadcom documentation in firmware package
4. Contact Broadcom support for controller-specific issues
