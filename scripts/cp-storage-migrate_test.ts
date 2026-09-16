#!/usr/bin/env -S deno test
/**
 * Unit tests for the pure helpers in cp-storage-migrate.ts. Nothing here opens
 * a socket, runs ssh/talosctl/kubectl or touches a cluster: the fixtures are
 * the output shapes from docs/runbooks/control-plane-storage.md.
 *
 *   deno test scripts/cp-storage-migrate_test.ts
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildConfig,
  DEFAULT_BWLIMIT,
  DEFAULT_NODES,
  DEFAULT_RAFT_TOLERANCE,
  dfRootArgv,
  etcdHealth,
  failingGates,
  filterNodes,
  findDatastore,
  formatDuration,
  type Gate,
  isNodeReady,
  isReadyzOk,
  kubectlNodesArgv,
  kubectlReadyzArgv,
  needsMigration,
  type NodeSpec,
  parseArgs,
  parseBwlimit,
  parseDfRootUsePercent,
  parseDuration,
  parseEtcdStatus,
  parseKubectlNodes,
  parseNodeSpecs,
  parsePercent,
  parsePvesmStatus,
  parseQmConfigDisk,
  parseQmStatus,
  parseSizeToGiB,
  pvesmStatusArgv,
  qmConfigArgv,
  qmMoveDiskArgv,
  qmShutdownArgv,
  qmStartArgv,
  qmStatusArgv,
  qmStopArgv,
  snapshotPath,
  type SshTarget,
  talosAddressesArgv,
  talosEtcdSnapshotArgv,
  talosEtcdStatusArgv,
  UsageError,
  vipHolders,
} from "./cp-storage-migrate.ts";

const SSH: SshTarget = { user: "root", host: "172.16.100.250" };
const IPS = ["172.16.100.11", "172.16.100.12", "172.16.100.13"];
const VIP = "172.16.100.10";

/**
 * talosctl renders its tables with a tabwriter: every column is padded to the
 * widest cell plus three spaces, and values may contain single spaces
 * ("131 MB"). This reproduces that layout so the fixtures below are laid out
 * exactly like real output.
 */
function tabwriter(rows: string[][]): string {
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length))
  );
  return rows
    .map((r) =>
      r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 3)))
        .join("").trimEnd()
    )
    .join("\n") + "\n";
}

const ETCD_HEADER = [
  "NODE",
  "MEMBER",
  "DB SIZE",
  "IN USE",
  "LEADER",
  "RAFT INDEX",
  "RAFT TERM",
  "LEARNER",
  "ERRORS",
];
const LEADER_ID = "3f9a1b2c3d4e5f60";

function etcdTable(
  rows: { node: string; member: string; index: string; errors?: string }[],
): string {
  return tabwriter([
    ETCD_HEADER,
    ...rows.map((r) => [
      r.node,
      r.member,
      "131 MB",
      "47 MB (35.88%)",
      LEADER_ID,
      r.index,
      "42",
      "false",
      r.errors ?? "",
    ]),
  ]);
}

const ETCD_HEALTHY = etcdTable([
  { node: IPS[0], member: "a1b2c3d4e5f60718", index: "14876322" },
  { node: IPS[1], member: "2c3d4e5f60718a1b", index: "14876320" },
  { node: IPS[2], member: LEADER_ID, index: "14876322" },
]);

// ----------------------------------------------------------------------------
// nodes and --only
// ----------------------------------------------------------------------------

Deno.test("parseNodeSpecs reads the three homelab control planes in order", () => {
  assertEquals(parseNodeSpecs(DEFAULT_NODES), [
    { name: "cp-1", vmid: 101, ip: "172.16.100.11" },
    { name: "cp-2", vmid: 102, ip: "172.16.100.12" },
    { name: "cp-3", vmid: 103, ip: "172.16.100.13" },
  ]);
});

Deno.test("parseNodeSpecs tolerates spaces and a trailing comma", () => {
  assertEquals(parseNodeSpecs(" cp-1 = 101 = 10.0.0.1 , cp-2=102=10.0.0.2, "), [
    { name: "cp-1", vmid: 101, ip: "10.0.0.1" },
    { name: "cp-2", vmid: 102, ip: "10.0.0.2" },
  ]);
});

Deno.test("parseNodeSpecs rejects malformed entries, bad VMIDs, bad IPs and duplicates", () => {
  for (
    const bad of [
      "",
      "cp-1",
      "cp-1=101",
      "cp-1=101=10.0.0.1=x",
      "CP1=101=10.0.0.1",
      "cp-1=99=10.0.0.1",
      "cp-1=abc=10.0.0.1",
      "cp-1=101=10.0.0.300",
      "cp-1=101=not-an-ip",
      "cp-1=101=10.0.0.1,cp-1=102=10.0.0.2",
      "cp-1=101=10.0.0.1,cp-2=101=10.0.0.2",
      "cp-1=101=10.0.0.1,cp-2=102=10.0.0.1",
    ]
  ) {
    assertThrows(() => parseNodeSpecs(bad), UsageError, undefined, bad);
  }
});

Deno.test("filterNodes keeps --nodes order and defaults to every node", () => {
  const nodes = parseNodeSpecs(DEFAULT_NODES);
  assertEquals(filterNodes(nodes, undefined).map((n) => n.name), [
    "cp-1",
    "cp-2",
    "cp-3",
  ]);
  assertEquals(filterNodes(nodes, "cp-2").map((n) => n.name), ["cp-2"]);
  // listed out of order, returned in migration order
  assertEquals(filterNodes(nodes, "cp-3,cp-1").map((n) => n.name), [
    "cp-1",
    "cp-3",
  ]);
  assertEquals(filterNodes(nodes, " cp-1 , cp-3 ").map((n) => n.name), [
    "cp-1",
    "cp-3",
  ]);
});

Deno.test("filterNodes rejects an unknown or empty --only", () => {
  const nodes = parseNodeSpecs(DEFAULT_NODES);
  assertThrows(
    () => filterNodes(nodes, "cp-4"),
    UsageError,
    "not a known node",
  );
  assertThrows(() => filterNodes(nodes, ""), UsageError, "at least one node");
});

// ----------------------------------------------------------------------------
// qm config: which datastore is the disk on
// ----------------------------------------------------------------------------

const QM_CONFIG_SOURCE = `boot: order=scsi0
cores: 4
cpu: host
memory: 8192
name: cp-1
net0: virtio=BC:24:11:01:01:01,bridge=vmbr0
numa: 0
ostype: l26
scsi0: vm-storage:vm-101-disk-0,iothread=1,size=64G,ssd=1
scsihw: virtio-scsi-single
smbios1: uuid=1b1c0f6e-9d0a-4a5a-9f3c-9d1b6a0c1f2e
sockets: 1
vmgenid: 6f2f6d0a-1f7a-4a2d-9d44-2f6a3d4b5c6d
`;

const QM_CONFIG_MIGRATED = QM_CONFIG_SOURCE.replace(
  "vm-storage:vm-101-disk-0",
  "cp-storage:vm-101-disk-0",
);

Deno.test("parseQmConfigDisk reads the datastore, volume and size of scsi0", () => {
  assertEquals(parseQmConfigDisk(QM_CONFIG_SOURCE, "scsi0"), {
    datastore: "vm-storage",
    volume: "vm-101-disk-0",
    sizeGiB: 64,
    raw: "scsi0: vm-storage:vm-101-disk-0,iothread=1,size=64G,ssd=1",
  });
});

Deno.test("parseQmConfigDisk returns null when the disk is absent and ignores scsi1/scsihw", () => {
  assertEquals(parseQmConfigDisk(QM_CONFIG_SOURCE, "virtio0"), null);
  assertEquals(parseQmConfigDisk("", "scsi0"), null);
  // scsihw starts with "scsi" but is not "scsi0:"
  assertEquals(
    parseQmConfigDisk("scsihw: virtio-scsi-single\n", "scsi0"),
    null,
  );
  assertEquals(
    parseQmConfigDisk("scsi1: nfs-media:vm-101-disk-1,size=2T\n", "scsi1")
      ?.sizeGiB,
    2048,
  );
});

Deno.test("parseSizeToGiB understands G, M, T and Proxmox's unitless MiB", () => {
  assertEquals(parseSizeToGiB("64G"), 64);
  assertEquals(parseSizeToGiB("65536M"), 64);
  assertEquals(parseSizeToGiB("1T"), 1024);
  assertEquals(parseSizeToGiB("1024"), 1);
  assertEquals(parseSizeToGiB("junk"), null);
});

Deno.test("needsMigration is true only for a disk on another datastore", () => {
  const source = parseQmConfigDisk(QM_CONFIG_SOURCE, "scsi0");
  const migrated = parseQmConfigDisk(QM_CONFIG_MIGRATED, "scsi0");
  assertEquals(needsMigration(source, "cp-storage"), true);
  assertEquals(needsMigration(migrated, "cp-storage"), false);
  // unknown disk: not claimed as "needs migrating"; the caller reports it
  assertEquals(needsMigration(null, "cp-storage"), false);
});

// ----------------------------------------------------------------------------
// qm status
// ----------------------------------------------------------------------------

Deno.test("parseQmStatus reads running, stopped and paused", () => {
  assertEquals(parseQmStatus("status: running\n"), "running");
  assertEquals(parseQmStatus("status: stopped\n"), "stopped");
  assertEquals(parseQmStatus("status: paused\n"), "paused");
  assertEquals(parseQmStatus("status: prelaunch\n"), "unknown");
  assertEquals(
    parseQmStatus(
      "Configuration file 'nodes/pve/qemu-server/199.conf' does not exist\n",
    ),
    "unknown",
  );
  assertEquals(parseQmStatus(""), "unknown");
});

// ----------------------------------------------------------------------------
// talosctl etcd status
// ----------------------------------------------------------------------------

Deno.test("parseEtcdStatus reads one member per node from the tabwriter table", () => {
  const members = parseEtcdStatus(ETCD_HEALTHY);
  assertEquals(members.length, 3);
  assertEquals(members[0].node, "172.16.100.11");
  assertEquals(members[0].member, "a1b2c3d4e5f60718");
  assertEquals(members[0].raftIndex, 14876322);
  assertEquals(members[0].raftTerm, 42);
  assertEquals(members[0].learner, false);
  assertEquals(members[0].errors, "");
  assertEquals(members[2].member, LEADER_ID);
});

Deno.test("parseEtcdStatus also reads the ID/PROTOCOL-VERSION column layout", () => {
  const text =
    `NODE            ID                 PROTOCOL-VERSION   DB SIZE   IN USE           LEADER             RAFT INDEX   RAFT TERM   LEARNER   ERRORS
172.16.100.11   a1b2c3d4e5f60718   3.5.0              131 MB    47 MB (35.88%)   3f9a1b2c3d4e5f60   14876322     42          false
`;
  const members = parseEtcdStatus(text);
  assertEquals(members.length, 1);
  assertEquals(members[0].node, "172.16.100.11");
  assertEquals(members[0].member, "a1b2c3d4e5f60718");
  assertEquals(members[0].raftIndex, 14876322);
  assertEquals(members[0].errors, "");
});

Deno.test("parseEtcdStatus returns nothing for an error message instead of a table", () => {
  assertEquals(
    parseEtcdStatus("rpc error: code = Unavailable desc = connection error\n"),
    [],
  );
});

Deno.test("etcdHealth accepts three members whose RAFT INDEX is within the tolerance", () => {
  const health = etcdHealth(parseEtcdStatus(ETCD_HEALTHY), 3);
  assertEquals(health.problems, []);
  assertEquals(health.ok, true);
});

Deno.test("etcdHealth rejects a member lagging further than --raft-tolerance", () => {
  const text = etcdTable([
    { node: IPS[0], member: "a1b2c3d4e5f60718", index: "14876322" },
    { node: IPS[1], member: "2c3d4e5f60718a1b", index: "14870001" },
    { node: IPS[2], member: LEADER_ID, index: "14876322" },
  ]);
  const health = etcdHealth(parseEtcdStatus(text), 3);
  assertEquals(health.ok, false);
  assertEquals(health.problems.length, 1);
  assertEquals(
    health.problems[0],
    `172.16.100.12 RAFT INDEX 14870001 is 6321 behind 14876322 (tolerance ${DEFAULT_RAFT_TOLERANCE})`,
  );
  // the same table passes with an explicit, wider tolerance
  assertEquals(etcdHealth(parseEtcdStatus(text), 3, 10_000).ok, true);
});

Deno.test("etcdHealth rejects a member with a non-empty ERRORS column", () => {
  const text = etcdTable([
    { node: IPS[0], member: "a1b2c3d4e5f60718", index: "14876322" },
    { node: IPS[1], member: "2c3d4e5f60718a1b", index: "14876322" },
    {
      node: IPS[2],
      member: LEADER_ID,
      index: "14876322",
      errors: "etcdserver: no leader",
    },
  ]);
  const health = etcdHealth(parseEtcdStatus(text), 3);
  assertEquals(health.ok, false);
  assertEquals(health.problems, [
    "172.16.100.13: ERRORS etcdserver: no leader",
  ]);
});

Deno.test("etcdHealth rejects a missing member, which is exactly the state that loses quorum next", () => {
  const text = etcdTable([
    { node: IPS[0], member: "a1b2c3d4e5f60718", index: "14876322" },
    { node: IPS[2], member: LEADER_ID, index: "14876322" },
  ]);
  const health = etcdHealth(parseEtcdStatus(text), 3);
  assertEquals(health.ok, false);
  assertEquals(health.problems, ["2 member(s) answered, expected 3"]);
});

Deno.test("etcdHealth rejects a table where the members disagree about the leader", () => {
  const rows = [
    [...ETCD_HEADER],
    [
      IPS[0],
      "a1b2c3d4e5f60718",
      "131 MB",
      "47 MB (35.88%)",
      "a1b2c3d4e5f60718",
      "14876322",
      "42",
      "false",
      "",
    ],
    [
      IPS[1],
      "2c3d4e5f60718a1b",
      "131 MB",
      "47 MB (35.88%)",
      LEADER_ID,
      "14876322",
      "42",
      "false",
      "",
    ],
  ];
  const health = etcdHealth(parseEtcdStatus(tabwriter(rows)), 2);
  assertEquals(health.ok, false);
  assertEquals(health.problems.length, 1);
  assertEquals(
    health.problems[0].startsWith("members disagree about the leader"),
    true,
  );
});

// ----------------------------------------------------------------------------
// df: the Proxmox root filesystem gate
// ----------------------------------------------------------------------------

const DF_ROOT =
  `Filesystem          1024-blocks     Used Available Capacity Mounted on
/dev/mapper/pve-root   98559220 55993312  37518564      60% /
`;

Deno.test("parseDfRootUsePercent reads the Use% of / from df -P", () => {
  assertEquals(parseDfRootUsePercent(DF_ROOT), 60);
});

Deno.test("parseDfRootUsePercent reads the 100% root seen during the investigation", () => {
  const full =
    `Filesystem          1024-blocks     Used Available Capacity Mounted on
/dev/mapper/pve-root   98559220 98559220         0     100% /
`;
  assertEquals(parseDfRootUsePercent(full), 100);
});

Deno.test("parseDfRootUsePercent ignores other mount points and unparseable output", () => {
  const other =
    `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sdb1         96153600  12345678  83807922      13% /mnt/pve/backup
`;
  assertEquals(parseDfRootUsePercent(other), null);
  assertEquals(parseDfRootUsePercent(""), null);
  assertEquals(
    parseDfRootUsePercent("df: /: No such file or directory\n"),
    null,
  );
});

// ----------------------------------------------------------------------------
// the VIP holder
// ----------------------------------------------------------------------------

const ADDRESSES =
  `NODE            NAMESPACE   TYPE            ID                      VERSION   ADDRESS             LINK
172.16.100.11   network     AddressStatus   eth0/172.16.100.11/24   1         172.16.100.11/24    eth0
172.16.100.12   network     AddressStatus   eth0/172.16.100.12/24   1         172.16.100.12/24    eth0
172.16.100.12   network     AddressStatus   eth0/172.16.100.10/32   1         172.16.100.10/32    eth0
172.16.100.13   network     AddressStatus   eth0/172.16.100.13/24   1         172.16.100.13/24    eth0
`;

Deno.test("vipHolders finds the single node carrying the API VIP as a /32", () => {
  assertEquals(vipHolders(ADDRESSES, VIP), ["172.16.100.12"]);
});

Deno.test("vipHolders returns nothing while the VIP is moving and both nodes during a split", () => {
  const none = ADDRESSES.split("\n").filter((l) => !l.includes("100.10/32"))
    .join("\n");
  assertEquals(vipHolders(none, VIP), []);
  const both = ADDRESSES +
    "172.16.100.13   network     AddressStatus   eth0/172.16.100.10/32   1         172.16.100.10/32    eth0\n";
  assertEquals(vipHolders(both, VIP), ["172.16.100.12", "172.16.100.13"]);
});

Deno.test("vipHolders does not match a node IP that merely starts with the VIP", () => {
  const text =
    `NODE            NAMESPACE   TYPE            ID                       VERSION   ADDRESS              LINK
172.16.100.11   network     AddressStatus   eth0/172.16.100.100/24   1         172.16.100.100/24    eth0
`;
  assertEquals(vipHolders(text, VIP), []);
});

// ----------------------------------------------------------------------------
// pvesm status: does the target datastore exist, and is there room
// ----------------------------------------------------------------------------

const PVESM =
  `Name             Type     Status           Total            Used       Available        %
cp-storage       zfspool  active       959200000          131072       959068928    0.01%
local            dir      active        98559220        55993312        37518564   56.81%
vm-storage       zfspool  active      1952448512       800123456      1152325056   40.98%
`;

Deno.test("parsePvesmStatus reads the datastores and converts KiB to GiB", () => {
  const entries = parsePvesmStatus(PVESM);
  assertEquals(entries.map((e) => e.name), [
    "cp-storage",
    "local",
    "vm-storage",
  ]);
  const cp = findDatastore(entries, "cp-storage");
  assertEquals(cp?.type, "zfspool");
  assertEquals(cp?.status, "active");
  assertEquals(Math.round(cp!.availGiB), 915);
  assertEquals(findDatastore(entries, "nope"), null);
});

Deno.test("parsePvesmStatus ignores the header and a disabled datastore's non-numeric row", () => {
  assertEquals(
    parsePvesmStatus("Name Type Status Total Used Available %\n"),
    [],
  );
  assertEquals(parsePvesmStatus(""), []);
});

// ----------------------------------------------------------------------------
// kubectl
// ----------------------------------------------------------------------------

const KUBECTL_NODES = `NAME       STATUS     ROLES           AGE    VERSION
cp-1       Ready      control-plane   412d   v1.34.1
cp-2       NotReady   control-plane   412d   v1.34.1
cp-3       Ready      control-plane   412d   v1.34.1
worker-1   Ready      <none>          412d   v1.34.1
`;

Deno.test("parseKubectlNodes and isNodeReady read the node table", () => {
  const rows = parseKubectlNodes(KUBECTL_NODES);
  assertEquals(rows.length, 4);
  assertEquals(isNodeReady(rows, "cp-1"), true);
  assertEquals(isNodeReady(rows, "cp-2"), false);
  assertEquals(isNodeReady(rows, "cp-9"), false);
});

Deno.test("isReadyzOk only accepts a trailing ok", () => {
  assertEquals(isReadyzOk("ok"), true);
  assertEquals(isReadyzOk("ok\n"), true);
  assertEquals(isReadyzOk("[+]etcd ok\nreadyz check failed\n"), false);
  assertEquals(isReadyzOk(""), false);
});

// ----------------------------------------------------------------------------
// flag validation
// ----------------------------------------------------------------------------

Deno.test("parseBwlimit accepts KiB/s and refuses junk, zero and negatives", () => {
  assertEquals(parseBwlimit("200000"), 200000);
  assertEquals(parseBwlimit(" 50 "), 50);
  for (const bad of ["", "0", "-1", "200000k", "1.5", "unlimited"]) {
    assertThrows(() => parseBwlimit(bad), UsageError, undefined, bad);
  }
});

Deno.test("parsePercent accepts 1..100 and names the flag it rejects", () => {
  assertEquals(parsePercent("90", "max-root-use"), 90);
  assertEquals(parsePercent("100", "max-root-use"), 100);
  for (const bad of ["0", "101", "", "90%", "ninety"]) {
    assertThrows(
      () => parsePercent(bad, "max-root-use"),
      UsageError,
      "--max-root-use",
      bad,
    );
  }
});

Deno.test("parseDuration accepts the timeout shapes the runbook uses", () => {
  assertEquals(parseDuration("5m", "shutdown-timeout"), 300_000);
  assertEquals(parseDuration("10m", "settle-timeout"), 600_000);
  assertEquals(parseDuration("60s", "settle-wait"), 60_000);
  assertEquals(parseDuration("90", "settle-wait"), 90_000);
  for (const bad of ["", "0", "-5s", "5 minutes", "1d"]) {
    assertThrows(
      () => parseDuration(bad, "settle-timeout"),
      UsageError,
      "--settle-timeout",
      bad,
    );
  }
});

Deno.test("formatDuration prints the shortest form", () => {
  assertEquals(formatDuration(300_000), "5m");
  assertEquals(formatDuration(60_000), "1m");
  assertEquals(formatDuration(15_000), "15s");
  assertEquals(formatDuration(250), "250ms");
});

Deno.test("buildConfig fills the homelab defaults", () => {
  const cfg = buildConfig(parseArgs(["migrate", "--yes"]));
  assertEquals(cfg.command, "migrate");
  assertEquals(cfg.yes, true);
  assertEquals(cfg.dryRun, false);
  assertEquals(cfg.ssh, { user: "root", host: "172.16.100.250" });
  assertEquals(cfg.context, "admin@homelab");
  assertEquals(cfg.vip, "172.16.100.10");
  assertEquals(cfg.disk, "scsi0");
  assertEquals(cfg.targetDatastore, "cp-storage");
  assertEquals(cfg.sourceDatastore, "vm-storage");
  assertEquals(cfg.bwlimit, DEFAULT_BWLIMIT);
  assertEquals(cfg.shutdownTimeoutMs, 300_000);
  assertEquals(cfg.settleTimeoutMs, 600_000);
  assertEquals(cfg.settleWaitMs, 60_000);
  assertEquals(cfg.maxRootUse, 90);
  assertEquals(cfg.nodes.map((n) => n.name), ["cp-1", "cp-2", "cp-3"]);
});

Deno.test("buildConfig applies --only, --bwlimit and --dry-run", () => {
  const cfg = buildConfig(
    parseArgs([
      "migrate",
      "--dry-run",
      "--only",
      "cp-2",
      "--bwlimit=100000",
      "--settle-wait",
      "30s",
    ]),
  );
  assertEquals(cfg.dryRun, true);
  assertEquals(cfg.bwlimit, 100000);
  assertEquals(cfg.settleWaitMs, 30_000);
  assertEquals(cfg.nodes.map((n) => n.vmid), [102]);
  // --only narrows the work, never the cluster-wide etcd/VIP checks
  assertEquals(cfg.allNodes.length, 3);
});

Deno.test("buildConfig refuses a Kind context, an identical source/target and a bad disk", () => {
  assertThrows(
    () =>
      buildConfig(parseArgs(["status", "--context", "kind-homelab-localdev"])),
    UsageError,
    "Kind context",
  );
  assertThrows(
    () =>
      buildConfig(parseArgs(["status", "--target-datastore", "vm-storage"])),
    UsageError,
    "both vm-storage",
  );
  assertThrows(
    () => buildConfig(parseArgs(["status", "--disk", "sda"])),
    UsageError,
    "--disk",
  );
  assertThrows(
    () => buildConfig(parseArgs(["status", "--vip", "172.16.100"])),
    UsageError,
    "--vip",
  );
});

Deno.test("parseArgs rejects unknown subcommands and flags, and treats -h as help", () => {
  assertEquals(parseArgs(["--help"]).command, "help");
  assertEquals(parseArgs([]).command, "help");
  assertEquals(parseArgs(["-h", "migrate"]).command, "help");
  assertThrows(() => parseArgs(["rollback"]), UsageError, "unknown subcommand");
  assertThrows(
    () => parseArgs(["status", "--nope"]),
    UsageError,
    "unknown flag",
  );
  assertThrows(
    () => parseArgs(["status", "--only"]),
    UsageError,
    "needs a value",
  );
  assertThrows(() => parseArgs(["status", "extra"]), UsageError, "unexpected");
});

Deno.test("failingGates treats unknown as a failure in a real run but not in a dry run", () => {
  const gates: Gate[] = [
    { name: "a", ok: true, detail: "" },
    { name: "b", ok: null, detail: "" },
    { name: "c", ok: false, detail: "" },
  ];
  assertEquals(failingGates(gates, false).map((g) => g.name), ["b", "c"]);
  assertEquals(failingGates(gates, true).map((g) => g.name), ["c"]);
});

// ----------------------------------------------------------------------------
// command builders: the exact argv that reaches the Proxmox host
// ----------------------------------------------------------------------------

const SSH_PREFIX = [
  "ssh",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "root@172.16.100.250",
];

Deno.test("qmMoveDiskArgv is exactly the runbook's move-disk command", () => {
  assertEquals(
    qmMoveDiskArgv(SSH, 101, "scsi0", "cp-storage", DEFAULT_BWLIMIT),
    [
      ...SSH_PREFIX,
      "qm move-disk 101 scsi0 cp-storage --delete 1 --bwlimit 200000",
    ],
  );
});

Deno.test("qmShutdownArgv, qmStartArgv, qmStopArgv and qmStatusArgv build one qm verb each", () => {
  assertEquals(qmShutdownArgv(SSH, 102), [...SSH_PREFIX, "qm shutdown 102"]);
  assertEquals(qmStartArgv(SSH, 102), [...SSH_PREFIX, "qm start 102"]);
  assertEquals(qmStopArgv(SSH, 103), [...SSH_PREFIX, "qm stop 103"]);
  assertEquals(qmStatusArgv(SSH, 103), [...SSH_PREFIX, "qm status 103"]);
  assertEquals(qmConfigArgv(SSH, 101), [...SSH_PREFIX, "qm config 101"]);
  assertEquals(pvesmStatusArgv(SSH), [...SSH_PREFIX, "pvesm status"]);
  assertEquals(dfRootArgv(SSH), [...SSH_PREFIX, "df -P /"]);
});

Deno.test("the ssh user and host are honoured", () => {
  assertEquals(
    qmStartArgv({ user: "pve-admin", host: "proxmox.example.test" }, 101),
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "pve-admin@proxmox.example.test",
      "qm start 101",
    ],
  );
});

Deno.test("the talosctl and kubectl argv match the runbook", () => {
  assertEquals(talosEtcdStatusArgv(IPS), [
    "talosctl",
    "-n",
    "172.16.100.11,172.16.100.12,172.16.100.13",
    "etcd",
    "status",
  ]);
  assertEquals(talosAddressesArgv(IPS), [
    "talosctl",
    "-n",
    "172.16.100.11,172.16.100.12,172.16.100.13",
    "get",
    "addresses",
  ]);
  assertEquals(talosEtcdSnapshotArgv(IPS[0], "/tmp/etcd.snapshot"), [
    "talosctl",
    "-n",
    "172.16.100.11",
    "etcd",
    "snapshot",
    "/tmp/etcd.snapshot",
  ]);
  assertEquals(kubectlReadyzArgv("admin@homelab"), [
    "kubectl",
    "--context",
    "admin@homelab",
    "get",
    "--raw",
    "/readyz",
  ]);
  assertEquals(kubectlNodesArgv("admin@homelab"), [
    "kubectl",
    "--context",
    "admin@homelab",
    "get",
    "nodes",
  ]);
});

Deno.test("snapshotPath names the file after the UTC start of the run", () => {
  assertEquals(
    snapshotPath("./etcd-snapshots", new Date("2026-09-15T18:04:05.123Z")),
    "etcd-snapshots/etcd-20260915T180405Z.snapshot",
  );
  assertEquals(
    snapshotPath("/tmp", new Date("2026-09-15T00:00:00.000Z")),
    "/tmp/etcd-20260915T000000Z.snapshot",
  );
});

Deno.test("the node list drives every per-node command", () => {
  const nodes: NodeSpec[] = parseNodeSpecs(DEFAULT_NODES);
  assertEquals(
    nodes.map((n) =>
      qmMoveDiskArgv(SSH, n.vmid, "scsi0", "cp-storage", 200000).at(-1)
    ),
    [
      "qm move-disk 101 scsi0 cp-storage --delete 1 --bwlimit 200000",
      "qm move-disk 102 scsi0 cp-storage --delete 1 --bwlimit 200000",
      "qm move-disk 103 scsi0 cp-storage --delete 1 --bwlimit 200000",
    ],
  );
});
