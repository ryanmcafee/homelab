# Storage rework: NVMe on CPU lanes, Optane SLOGs, mirrored cp-storage

Keep the consumer QLC drives (Crucial P310) for capacity, move every NVMe drive off the
tri-mode HBAs onto bifurcated CPU lanes, put a mirrored Optane SLOG in front of each pool that
takes sync writes, and mirror `cp-storage`.

## Why

| Finding | Effect |
|---------|--------|
| No drive in the host has power-loss protection (P310, 990 PRO, 960 EVO) | Every `fsync` waits for a NAND flush: 1-20 ms, spiking under load (the etcd `slow fdatasync` class of incident) |
| The four P310s sit behind two Broadcom 9400-8i (SAS3408) tri-mode HBAs | The OS sees them as SCSI (`TRAN=sas`): no native NVMe queues, no NVMe passthrough per drive, and very likely no Host Memory Buffer, which DRAM-less drives depend on for random I/O |
| `cp-storage` is a single Samsung 990 PRO | One device failure takes down the disk of all three control planes at once |
| TrueNAS `boot-pool` (`/dev/vda3`, on `vm-storage`) reports DEGRADED, "too many slow I/Os" | Symptom of the same slow-sync QLC path |

## Current state (verified 2026-11-21)

| Item | Value |
|------|-------|
| Board / CPU / RAM | Supermicro H12SSL-NT (BIOS 3.1), EPYC 7413, 4x 64 GB DDR4-3200 RDIMM (DIMMC1, D1, G1, H1; A1, B1, E1, F1 empty) |
| SLOT3 x16 | Intel Arc Pro B50 (passed to worker-1) |
| SLOT5 x16 | 9400-8i: 2x P310, TrueNAS pool `ssd` (mapping `hba-nvme-ssds`) |
| SLOT7 x16 | 9400-8i: 2x P310, Proxmox pool `vm-storage` (`/dev/sdc`, `/dev/sdd`) |
| SLOT1, SLOT6 (x16), SLOT2, SLOT4 (x8) | free |
| M.2-M1 / M.2-M2 | 990 PRO (`cp-storage`), 960 EVO (Proxmox boot) |
| JNVMe0 / JNVMe1 (SlimSAS) | SATA mode: the 11x 20 TB `storage` disks (mappings `sata-20tb-drives`, `sata-20tb-drives-2`); not available for NVMe |

Bifurcation support (manual MNL-2314, UEFI BIOS chapter): every x16 slot offers `Auto, x16,
x8x8, x4x4x8, x4x4x4x4`; SLOT2 and SLOT4 offer `Auto, x4x4`.

## Hardware

| Qty | Part | Slot / purpose |
|-----|------|----------------|
| 2 | ASUS Hyper M.2 x16 Gen4 (passive, 4x M.2 up to 22110) | SLOT1 (host), SLOT6 (TrueNAS) |
| 1 | Supermicro AOC-SLG4-2M2 (passive, 2x M.2) | SLOT2 (`cp-storage` mirror) |
| 4 | Intel Optane DC P4801X 375 GB, M.2 22110 (PLP, 60 DWPD) | mirrored SLOG pairs, host and TrueNAS |
| 1 | Micron 7450 PRO 1.92 TB, M.2 22110 (PLP) | `cp-storage` mirror |

- `zpool attach` needs a device at least as large as the existing one; a 960 GB drive will not
  attach to the 1 TB 990 PRO, so 1.92 TB is the smallest PLP option. The mirror stays 1 TB usable
  until the 990 PRO is replaced.
- Optane is discontinued: buy used and check SMART wear. The P1600X 118 GB (M.2 2280) is enough
  for SLOG only; the P4801X leaves room for Phase 4.
- A SLOG holds about two transaction groups (roughly 5-10 s of writes); more than about 32 GB
  per pool does not make sync writes faster.

## Target layout

| Slot | Bifurcation | Owner | Contents |
|------|-------------|-------|----------|
| SLOT1 | x4x4x4x4 | Proxmox | 2x P310 (`vm-storage`), 2x P4801X (logs) |
| SLOT2 | x4x4 | Proxmox | Micron 7450 PRO (`cp-storage` mirror), 1 free bay |
| SLOT6 | x4x4x4x4 | TrueNAS, one passthrough per drive | 2x P310 (`ssd`), 2x P4801X (`ssd` log) |
| SLOT5, SLOT7 | - | - | HBAs removed, kept as spares |
| M.2-M1 / M.2-M2 | - | Proxmox | 990 PRO (`cp-storage`), 960 EVO (boot) |
| JNVMe0 / JNVMe1 | unchanged | TrueNAS | SATA, 11x 20 TB |

Host Optane partitions (identical on both drives, each pair mirrored):

| Partition | Size | Use |
|-----------|------|-----|
| p1 | 32G | `vm-storage` log |
| p2 | 32G | `cp-storage` log |
| p3 | rest | reserved for Phase 4 |

TrueNAS assigns whole disks in its UI, so its P4801X pair is a whole-disk log mirror for `ssd`.

Resulting pools: `vm-storage` = P310 mirror + log mirror; `cp-storage` = 990 PRO / 7450 PRO
mirror + log mirror; `ssd` = P310 mirror + log mirror; `storage` unchanged.

## Phase 0: baseline and safety (no downtime)

1. Run the etcd `fio` check (`--fdatasync=1 --bs=2300`) on `cp-storage`, `vm-storage` and `ssd`;
   record fdatasync p99.
2. Record the serial number and pool of every P310.
3. `talosctl etcd snapshot`, confirm the latest CloudNativePG barman backup, snapshot the TrueNAS
   `ssd` pool.

## Phase 1: repository PR (merged before the window, applied during it)

- `terragrunt/environments/homelab/env.hcl`: replace `hba-nvme-ssds` with per-drive mappings
  (`nvme-ssd-1`, `nvme-ssd-2`, `nvme-slog-1`, `nvme-slog-2`); PCI addresses, IDs and IOMMU groups
  are filled in after the hardware swap. Drop the stale NVIDIA P2200 `gpu_*` block.
- `terragrunt/modules/proxmox-zfs-pool`: idempotent steps for `zfs_log_devices`
  (`zpool add <pool> log mirror ...` when the pool has no log vdev), `zfs_mirror_attach`
  (`zpool attach` when the pool is a single device and the config says `mirror`), and Optane
  partitioning with `sgdisk` only when the device has no partition table.
- `proxmox-zfs-pool` unit: `/dev/sdc`, `/dev/sdd` -> `/dev/disk/by-id/nvme-...`; add log partitions.
- `proxmox-zfs-pool-cp` unit: `zfs_pool_type = "mirror"`, add the 7450 PRO `by-id` path and log
  partitions, rewrite the header that justifies a single device.
- `docs/project_notes/decisions.md`: new entry superseding ADR-016 (`cp-storage` mirror + SLOG).
- `docs/hardware.md`: both 9400-8i HBAs, carriers, the layout above; a runbook for the migration.
- `CLAUDE.local.md.example` and the `CLAUDE.md` environment table: Intel Arc Pro B50.
- `task tf:plan:component` for `truenas`, `proxmox-zfs-pool`, `proxmox-zfs-pool-cp`: every change
  must be in place, no VM replacement.

## Phase 2: maintenance window (full host downtime)

> **Never import `ssd` on the Proxmox host.** Its drives are visible to the host before
> passthrough binds them; importing a pool on two systems corrupts it.
>
> **`zpool attach` order matters:** the existing 990 PRO partition comes first. Check every
> `by-id` path in the Terraform plan before applying.

1. Stop the workers, then the control planes, then TrueNAS (VM 150); power off the host.
2. Install SLOT1, SLOT2 and SLOT6 carriers; move the P310s; add the Optanes and the 7450 PRO;
   remove both HBAs.
3. BIOS: `CPU SLOT1/SLOT6 PCI-E 4.0 X16 Bifurcation = x4x4x4x4`,
   `CPU SLOT2 PCI-E 4.0 X8 Bifurcation = x4x4`; leave `JNVMe0/1` unchanged.
4. Host checks: `nvme list` shows 8 devices; `nvme get-feature -f 0x0d -H` shows HMB enabled on
   the P310s; each NVMe in its own IOMMU group; `vm-storage` and `cp-storage` imported.
5. Fill the PCI addresses into `env.hcl`; `task tf:apply:component` for `proxmox-zfs-pool`,
   `proxmox-zfs-pool-cp`, `truenas`.
6. Wait for the `cp-storage` resilver (`zpool status cp-storage`; about 30 GB, minutes, online).
7. Start TrueNAS; `ssd` imports by partuuid; add the Optane log mirror; `autotrim=on`.
8. Start the control planes, then the workers; check etcd, ArgoCD, CloudNativePG, democratic-csi.

## Phase 3: verify

- `fio` fdatasync p99 well under 1 ms on all three pools, compared with Phase 0.
- `zpool status`: `cp-storage` shows `mirror-0` and a `logs` mirror, 0 errors.
- `zpool iostat -v` shows writes on the log vdevs.
- No etcd `slow fdatasync`; `task apiserver:probe` clean.
- Drill: `zpool offline cp-storage <990 PRO>`, etcd keeps running, `zpool online`, resilver.
- Re-check the TrueNAS `boot-pool` DEGRADED state.

## Phase 4 (optional, separate decision): special vdev

The best target is the TrueNAS `storage` pool (raidz3, 220 TB): metadata on Optane speeds up
listings, scrubs and the *arr apps. `vm-storage` gains little (mostly zvols).

> A special vdev is pool-critical: losing it loses the pool, and on raidz it cannot be removed.
> Matching raidz3 needs a 3-way Optane mirror (5-6 Optanes in total).

## Rollback

Reinstall the HBAs and move the P310s back; revert the `env.hcl` PR; `zpool detach cp-storage
<7450 PRO>`; `zpool remove <pool> <log mirror>`. Pools import by label from either path. Phase 4
has no simple rollback on raidz.
