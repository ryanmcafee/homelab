# Control-plane storage: moving etcd off the shared pool

The Kubernetes API used to drop out for tens of seconds at a time. The cause was never the API
server: the three control-plane VM system disks lived on the same Proxmox ZFS mirror as every
worker disk, so a single worker image unpack stalled etcd's write-ahead-log fsync for seconds,
leases expired and the Talos layer-2 VIP moved. ADR-016 has the decision; `docs/project_notes/bugs.md`
(2026-09-15) has the evidence. This runbook is the migration, the verification and the rollback.

Agents never run any of this: every step below mutates production (ADR-009). An agent may run the
read-only checks in [Verify](#verify) and [Diagnose a recurrence](#diagnose-a-recurrence).

## How it fits together

| Piece | Where | What it does |
|-------|-------|--------------|
| Datastore `cp-storage` | `terragrunt/environments/homelab/proxmox-zfs-pool-cp` | Single-device ZFS pool on the NVMe, registered as a Proxmox `images` datastore |
| CP disks on it | `terragrunt/modules/talos-cluster` `control_plane_datastore_id` → `coalesce(...)` on the control-plane `disk` block | Control-plane system disks (and therefore Talos EPHEMERAL, where etcd stores its data) leave `vm-storage` |
| etcd tuning | `terragrunt/environments/homelab/talos-cluster/terragrunt.hcl` `controlplane_config_patches` → `cluster.etcd.extraArgs` | `heartbeat-interval=250`, `election-timeout=2500`, `listen-metrics-urls=http://0.0.0.0:2381` |
| etcd scrape + alerts | `charts/addons/templates/kube-prometheus-stack.yaml` (`kubeEtcd`, `additionalPrometheusRulesMap`), endpoints from `CP1_IP`/`CP2_IP`/`CP3_IP` | Makes the next occurrence visible instead of invisible |
| Probe | `task apiserver:probe` / `task apiserver:stress` (`scripts/apiserver-stress.ts`) | Read-only; probes the VIP and each control plane side by side so a VIP failover is distinguishable from an API outage |

The NVMe is a single device on purpose: etcd is replicated across the three nodes, and isolation from
worker I/O buys far more availability than a mirror of the same device class would. The trade-off and
the alternative (adding the NVMe as a SLOG to `vm-storage` instead) are recorded in ADR-016.

## Before you start

- The target device is `/dev/disk/by-id/nvme-Samsung_SSD_990_PRO_1TB_S6Z1NU0XC45503Z`. **`zpool create -f`
  wipes it.** Confirm it is unused first — no partitions, no LVM PV, no ZFS label:
  ```bash
  ssh root@172.16.100.250 'lsblk /dev/nvme0n1; pvs; blkid /dev/nvme0n1*; zpool import'
  ```
  Expect: no partition rows, no PV on `nvme0n1`, no `blkid` output, and `zpool import` not offering a
  pool from it. If any of those show data, **stop** and pick another device.
- Proxmox root filesystem must not be full. It was 100 % full (`/var/lib/vz/dump`, 59 G) during the
  investigation because of an unmanaged daily `vzdump` job; see [Host housekeeping](#host-housekeeping).
- Take an etcd snapshot and keep it off-cluster:
  ```bash
  talosctl -n 172.16.100.11 etcd snapshot /tmp/etcd-$(date -u +%Y%m%dT%H%M%SZ).snapshot
  ```
- Know which node holds the VIP, so you can watch it move:
  ```bash
  talosctl -n 172.16.100.11,172.16.100.12,172.16.100.13 get addresses | rg 172.16.100.10/
  ```
- Start a probe in another terminal and leave it running through the whole migration:
  ```bash
  task apiserver:probe -- --context admin@homelab \
    --endpoint https://172.16.100.11:6443 --endpoint https://172.16.100.12:6443 \
    --endpoint https://172.16.100.13:6443 --duration 60m --json /tmp/migration-probe.json
  ```

## Migration

**Read this first — Terraform does not move the disk.** The control-plane VM resource has
`lifecycle { ignore_changes = [disk, ...] }` (`terragrunt/modules/talos-cluster/main.tf`), which is
deliberate: without it, a routine machine-config edit cascades into VM recreation. The consequence
is that flipping `control_plane_datastore_id` on an existing control plane produces **no plan diff
at all**. `coalesce(var.control_plane_datastore_id, var.datastore_id)` is what puts a *newly
created* control plane on `cp-storage` and what keeps the intent declared in code. Moving the three
disks that already exist is a manual, one-node-at-a-time Proxmox operation. Do not "fix" this by
removing `disk` from `ignore_changes`.

**1. Create the datastore.**

```bash
task tf:apply:component COMPONENT=proxmox-zfs-pool-cp     # plan first: 1 to add, no resource pool
ssh root@172.16.100.250 'zpool list cp-storage; zfs get compression,atime,recordsize cp-storage'
```

**2. Move one control-plane disk, with the VM stopped.**

The copy reads ~5 GB from `vm-storage` — the very pool whose saturation causes the outage, and the
two control planes still on it are serving the API while you do this. Throttle the copy and do it
when the cluster is quiet. Stopping the VM first keeps the moving node's own etcd out of the way;
the other two hold quorum.

```bash
# cp-1 = VM 101 (172.16.100.11), cp-2 = 102 (.12), cp-3 = 103 (.13)
ssh root@172.16.100.250 'qm shutdown 101 && qm wait 101'
ssh root@172.16.100.250 'qm move-disk 101 scsi0 cp-storage --delete 1 --bwlimit 200000'
ssh root@172.16.100.250 'qm config 101 | grep scsi0'    # expect cp-storage:vm-101-disk-0
ssh root@172.16.100.250 'qm start 101'
```

`scripts/cp-storage-migrate.ts` automates exactly this step — one node at a time, with the checks
below as gates between nodes. It does not touch step 1 or step 3.

```bash
task cp:migrate:status            # read-only: which nodes are still on vm-storage
task cp:migrate -- --dry-run      # every ssh/talosctl/kubectl command it would run, in order
task cp:migrate -- --yes          # the real thing; --only cp-2 restricts it to one node
```

It refuses to start without `--yes`, takes the etcd snapshot itself (`--snapshot-dir`, default
`./etcd-snapshots`, gitignored because **an etcd snapshot contains every Kubernetes Secret in
plaintext** — treat those files as credentials; `--skip-snapshot` to skip), throttles with `--bwlimit` (default 200000), polls `qm status` instead of
`qm wait` and never issues `qm stop` unless `--force-stop` is passed, and stops the whole run at the
first failure. Its etcd gate reads "matching RAFT INDEX" as "within `--raft-tolerance` (default 10)
of the highest", because the three members are queried at slightly different moments on a cluster
that keeps writing.

Then wait for the cluster to be whole again **before the next node**:

```bash
talosctl -n 172.16.100.11,172.16.100.12,172.16.100.13 etcd status   # 3 members, matching RAFT INDEX, no ERRORS
talosctl -n 172.16.100.11,172.16.100.12,172.16.100.13 get addresses | rg 172.16.100.10/
kubectl --context admin@homelab get --raw '/readyz?verbose' | tail -3
```

Repeat for VM 102 and VM 103. If etcd does not return to three healthy members, **stop** and recover
that node ([Rollback](#rollback)) before touching the next one. Losing a second member while one is
down loses quorum and the API with it.

Terraform state still records the old datastore for those disks. That is harmless — `disk` is
ignored, so nothing will act on it — and it self-corrects if a control plane is ever recreated.

**3. Apply the etcd tuning — one node at a time.**

The patches are rendered by the `talos-cluster` component but applied to the running nodes by
`talos_machine_configuration_apply` in **`talos-cluster-config`**, which is `for_each` over all three
control planes. A plain apply would restart all three etcd members at once and drop quorum, so
target one node per apply:

```bash
cd terragrunt/environments/homelab/talos-cluster        # regenerate the machine configs
terragrunt apply                                         # output-only change; VMs untouched (disk/initialization ignored)

cd ../talos-cluster-config
terragrunt apply -target='talos_machine_configuration_apply.controlplane["cp-1"]'
# verify etcd + VIP + readyz as above, then cp-2, then cp-3
```

**Applying the config does not restart etcd — you must reboot the node.** Verified on 2026-09-16:
after `talos_machine_configuration_apply`, `talosctl get machineconfig` shows the new `extraArgs`,
but `talosctl services etcd` shows no restart and the metrics port stays closed, so etcd keeps
running with the old timeouts. `talosctl service etcd restart` is refused ("service \"etcd\" doesn't
support restart operation via API") because etcd is managed by the machine-config controller. Reboot
each node after its apply:

```bash
talosctl -n 172.16.100.11 reboot
# then poll until the member is back, the API is up and the metrics port answers:
talosctl -n 172.16.100.11,172.16.100.12,172.16.100.13 etcd status
kubectl --context admin@homelab get --raw /readyz
ssh root@172.16.100.250 'curl -s -o /dev/null -w "%{http_code}\n" http://172.16.100.11:2381/metrics'  # 200
```

Each node came back inside 40 s and `/readyz` never stopped returning `ok`, because the VIP moves to
a surviving node. Confirm the tuning is really live rather than merely configured:

```bash
talosctl -n 172.16.100.11 logs etcd | grep -o 'heartbeat-interval=[0-9]*\|election-timeout=[0-9]*'
```

`heartbeat-interval` and `election-timeout` must end up identical on all three members — a
half-finished rollout is the one state to avoid, so complete all three once you have started.

**4. Let ArgoCD pick up the monitoring change** (an ordinary addons sync; no manual step).

## Verify

Read-only, safe for agents:

```bash
# every control-plane disk on cp-storage, etcd healthy, /readyz ok, the VIP held by one node
deno run --allow-net --allow-run --allow-env --allow-read --allow-write \
  scripts/cp-storage-migrate.ts verify [--prometheus-url http://127.0.0.1:9091]

# etcd is healthy and now scraped
talosctl -n 172.16.100.11,172.16.100.12,172.16.100.13 etcd status
kubectl --context admin@homelab -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9091:9090 &
curl -s 'http://127.0.0.1:9091/api/v1/query?query=up{job="kube-etcd"}' | jq '.data.result[].value[1]'   # three 1s

# the thing that used to break: WAL fsync p99 under a worker write burst
curl -s --data-urlencode 'query=histogram_quantile(0.99, sum by (le) (rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])))' \
  http://127.0.0.1:9091/api/v1/query | jq -r '.data.result[].value[1]'                                  # want < 0.05

# CP VMs should no longer stall on I/O (was 0.25-0.30 "full avg300" before)
ssh root@172.16.100.250 'for v in 101 102 103; do cat /sys/fs/cgroup/qemu.slice/$v.scope/io.pressure; done'
```

The probe you left running should report zero failures and no outage window. A successful migration
also shows up as silence: `leader failed to send out heartbeat on time` should disappear from
`talosctl -n <cp> logs etcd`, where it used to appear a few times an hour.

## Rollback

Per node, and only for a node that has not come back:

1. Set `control_plane_datastore_id = null` in `terragrunt/environments/homelab/talos-cluster/terragrunt.hcl`
   (or override the input) so the disk block falls back to `datastore_id` (`vm-storage`).
2. `terragrunt apply -target='proxmox_virtual_environment_vm.controlplane["cp-N"]'` — again check the
   plan says in-place update, not replace.
3. If the VM will not boot at all, restore the node from the etcd snapshot following
   `docs/runbooks/talos-upgrade.md` ("etcd quorum recovery"), then re-add it.

Rolling back only the etcd tuning is independent: drop `controlplane_config_patches` and re-apply.
The defaults (100 ms / 1000 ms) are safe, just less tolerant of disk stalls.

## Diagnose a recurrence

If the API goes away again, these four answers separate the three plausible causes in a couple of
minutes. All are read-only.

| Question | Command | Reads as |
|----------|---------|----------|
| Is it the VIP or the API? | `task apiserver:probe -- --duration 2m --endpoint https://172.16.100.11:6443 --endpoint https://172.16.100.12:6443 --endpoint https://172.16.100.13:6443` | The VIP failing while the three node IPs answer = VIP failover, not an API outage |
| Is etcd stalling on disk? | `talosctl -n 172.16.100.13 logs etcd \| rg -i "slow fdatasync\|heartbeat on time"` | Any multi-second `slow fdatasync` = storage, not Kubernetes |
| Who is writing? | Prometheus `sum by (instance) (rate(node_disk_written_bytes_total{device="sda"}[5m])) * 300 / 1048576` | GB-scale bursts on a worker = an image unpack or a media write |
| Did leases expire? | `kubectl -n kube-system logs kube-controller-manager-<node> --previous \| rg leaderelection` | `failed to renew lease` = downstream symptom, never the cause |

`sda` is the Talos system disk (the pool under investigation). `sdb`/`sdc` are democratic-CSI
iSCSI volumes from TrueNAS and are a different device entirely — Prometheus writing 2.5 GB every six
hours to `sdb` is normal and does not touch control-plane storage.

### What the API server can actually take

Measured 2026-09-16 against the cluster before the migration, read-only GETs from one laptop:

| Load | Result |
|---|---|
| Idle, 5 min, VIP + all three control planes | 2400 requests, 0 failures, p50 9 ms, p99 27 ms |
| 64 concurrent workers against the VIP, 15 s | 742 req/s, 0 errors, p50 59 ms, p99 302 ms |

**The API server is not the bottleneck and never was.** During a ramp the server reported p99 24 ms
with zero API Priority and Fairness queueing and zero 429s. Read load does not reproduce the outage,
because the outage is a *write*-path stall (etcd WAL fsync) caused by other VMs on the same disk.
Reproducing it on purpose means generating a multi-GB write burst on a worker, which causes a real
outage — do not do that on production to "confirm" the diagnosis.

One caveat about the tool: spreading high concurrency across four endpoints can saturate the client
machine before the server. When `stress` sees load timeouts while the independent probe stays healthy
and the completed load requests are fast, it prints a `client-limited` warning — read that step as a
limit of the machine running the test, not of the cluster.

## Host housekeeping

### Root filesystem and log retention (fixed 2026-09-16)

The Proxmox root filesystem was **100 % full, with zero bytes free**, and had been since April.

The `vzdump` job `dev-daily-backup` backs up every VM to `local`, which is the 67 GB `pve-root` LVM
itself. A full set of VM images is around 60 GB, so it filled the volume on 2026-04-13 and every run
since failed with `vma_queue_write: write error - Broken pipe`. Because vzdump prunes only **after** a
successful run, its `keep-daily=3,keep-weekly=2` policy never executed: 59 GB of April archives and
1421 daily failure logs accumulated. Postfix could not queue mail either.

Fixed and codified in `ansible/roles/proxmox_log_retention` (playbook
`ansible/playbooks/proxmox-log-retention.yml`), which is idempotent and safe to re-run:

```bash
cd ansible && ansible-playbook -i inventory/homelab.yml playbooks/proxmox-log-retention.yml
```

| Setting | Value |
|---|---|
| journald | `MaxRetentionSec=7day`, `SystemMaxUse=1G`, `SystemKeepFree=8G`, `RuntimeMaxUse=256M` |
| logrotate (global) | `daily`, `rotate 7` |
| logrotate (`pveam.log`, `vzdump/*.log`) | `daily`, `rotate 7` |
| `/var/lib/vz/dump` | anything older than 7 days pruned |
| `dev-daily-backup` | `prune-backups keep-daily=7`, **disabled** |

Result: root went from 100 % (0 B free) to **11 % used, 57 GB free**; the journal dropped from 241 MB
on disk to 12 KB, and the runtime journal from 2.5 GB of RAM to 223 MB.

**The backup job is intentionally left disabled.** It has produced nothing since April, and `local`
is the only Proxmox storage that accepts backups. Before re-enabling it, give it a destination with
room — TrueNAS over NFS is the right answer; `vm-storage` is acceptable **only after** the control
planes have moved to `cp-storage`, because a nightly multi-GB write to `vm-storage` is precisely the
burst that stalls etcd. Re-enable with `proxmox_backup_job_enabled: true` once that is true.

Two notes: the logrotate config deliberately does not list `/var/log/pveproxy/access.log` (owned by
`/etc/logrotate.d/pve`, already daily with 7 rotations) or `/var/log/pve/*.log` (pvedaemon task logs)
— a path listed in two logrotate configs is **skipped entirely**, not rotated twice. And 157 old
undeliverable failure mails remain in the postfix queue; they are harmless and small (~4.5 MB).

### Still open

- **`~/.talos/config` lists only two endpoints** (.11 and .12). Add 172.16.100.13.
- **Unused Cilium LB pool `control-plane-vip`** (`charts/addons/templates/cilium-lb-ipam.yaml`) holds
  172.16.100.10, the API VIP. No Service carries the `cilium.io/pool: control-plane-vip` label today,
  but one that did would announce the API VIP from a worker over L2 and break the API. It is unused —
  consider removing it.
- There is no `terragrunt/environments/homelab/proxmox-backup-policy` instance, which is why
  Terraform never knew about the backup job. The module exists if you want it managed.
