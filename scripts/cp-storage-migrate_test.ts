#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure helpers in cp-storage-migrate.ts. Nothing here opens
 * a socket, runs ssh/talosctl/kubectl or touches a cluster: the fixtures are
 * the output shapes from docs/runbooks/control-plane-storage.md.
 *
 *   bun test scripts/cp-storage-migrate_test.ts
 */

import { test } from "bun:test";
import { assertEquals, assertThrows } from "./lib/assert.ts";
import {
  type ArgEnv,
  buildConfig,
  cpKeysFromEnvFile,
  cpNodeDefaultsFromEnvFile,
  DEFAULT_BWLIMIT,
  DEFAULT_RAFT_TOLERANCE,
  dfRootArgv,
  envFileValue,
  etcdHealth,
  failingGates,
  filterNodes,
  findDatastore,
  findKubeNode,
  formatDuration,
  type Gate,
  isNodeReady,
  isReadyzOk,
  kubectlNodesArgv,
  kubectlReadyzArgv,
  needsMigration,
  nodesFromEnvFile,
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

/**
 * Every address here is RFC 5737 TEST-NET-1 (192.0.2.0/24), reserved for
 * documentation and unroutable: no real topology belongs in this repository.
 * The script itself reads the real addresses from the gitignored
 * configuration/environments/homelab.yaml at run time.
 */
const PROXMOX_HOST = "192.0.2.250";
const SSH: SshTarget = { user: "root", host: PROXMOX_HOST };
const IPS = ["192.0.2.11", "192.0.2.12", "192.0.2.13"];
const VIP = "192.0.2.10";
/** The --nodes spec nodesFromEnvFile derives from the CPn_IP keys present. */
const NODES = `cp-1=101=${IPS[0]},cp-2=102=${IPS[1]},cp-3=103=${IPS[2]}`;
/** What readEnvDefaults hands parseArgs when the environment file is complete. */
const ENV: ArgEnv = { nodes: NODES, proxmoxHost: PROXMOX_HOST, vip: VIP };

/**
 * talosctl renders its tables with a tabwriter: every column is padded to the
 * widest cell plus three spaces, and values may contain single spaces
 * ("131 MB"). This reproduces that layout so the fixtures below are laid out
 * exactly like real output.
 */
function tabwriter(rows: string[][]): string {
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  return (
    rows
      .map((r) =>
        r
          .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 3)))
          .join("")
          .trimEnd(),
      )
      .join("\n") + "\n"
  );
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

test("parseNodeSpecs reads the three homelab control planes in order", () => {
  assertEquals(parseNodeSpecs(NODES), [
    { name: "cp-1", vmid: 101, ip: "192.0.2.11" },
    { name: "cp-2", vmid: 102, ip: "192.0.2.12" },
    { name: "cp-3", vmid: 103, ip: "192.0.2.13" },
  ]);
});

test("parseNodeSpecs tolerates spaces and a trailing comma", () => {
  assertEquals(
    parseNodeSpecs(" cp-1 = 101 = 192.0.2.1 , cp-2=102=192.0.2.2, "),
    [
      { name: "cp-1", vmid: 101, ip: "192.0.2.1" },
      { name: "cp-2", vmid: 102, ip: "192.0.2.2" },
    ],
  );
});

test("parseNodeSpecs rejects malformed entries, bad VMIDs, bad IPs and duplicates", () => {
  for (const bad of [
    "",
    "cp-1",
    "cp-1=101",
    "cp-1=101=192.0.2.1=x",
    "CP1=101=192.0.2.1",
    "cp-1=99=192.0.2.1",
    "cp-1=abc=192.0.2.1",
    "cp-1=101=192.0.2.300",
    "cp-1=101=not-an-ip",
    "cp-1=101=192.0.2.1,cp-1=102=192.0.2.2",
    "cp-1=101=192.0.2.1,cp-2=101=192.0.2.2",
    "cp-1=101=192.0.2.1,cp-2=102=192.0.2.1",
  ]) {
    assertThrows(() => parseNodeSpecs(bad), UsageError, undefined, bad);
  }
});

test("filterNodes keeps --nodes order and defaults to every node", () => {
  const nodes = parseNodeSpecs(NODES);
  assertEquals(
    filterNodes(nodes, undefined).map((n) => n.name),
    ["cp-1", "cp-2", "cp-3"],
  );
  assertEquals(
    filterNodes(nodes, "cp-2").map((n) => n.name),
    ["cp-2"],
  );
  // listed out of order, returned in migration order
  assertEquals(
    filterNodes(nodes, "cp-3,cp-1").map((n) => n.name),
    ["cp-1", "cp-3"],
  );
  assertEquals(
    filterNodes(nodes, " cp-1 , cp-3 ").map((n) => n.name),
    ["cp-1", "cp-3"],
  );
});

test("filterNodes rejects an unknown or empty --only", () => {
  const nodes = parseNodeSpecs(NODES);
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

test("parseQmConfigDisk reads the datastore, volume and size of scsi0", () => {
  assertEquals(parseQmConfigDisk(QM_CONFIG_SOURCE, "scsi0"), {
    datastore: "vm-storage",
    volume: "vm-101-disk-0",
    sizeGiB: 64,
    raw: "scsi0: vm-storage:vm-101-disk-0,iothread=1,size=64G,ssd=1",
  });
});

test("parseQmConfigDisk returns null when the disk is absent and ignores scsi1/scsihw", () => {
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

test("parseSizeToGiB understands G, M, T and Proxmox's unitless MiB", () => {
  assertEquals(parseSizeToGiB("64G"), 64);
  assertEquals(parseSizeToGiB("65536M"), 64);
  assertEquals(parseSizeToGiB("1T"), 1024);
  assertEquals(parseSizeToGiB("1024"), 1);
  assertEquals(parseSizeToGiB("junk"), null);
});

test("needsMigration is true only for a disk on another datastore", () => {
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

test("parseQmStatus reads running, stopped and paused", () => {
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

test("parseEtcdStatus reads one member per node from the tabwriter table", () => {
  const members = parseEtcdStatus(ETCD_HEALTHY);
  assertEquals(members.length, 3);
  assertEquals(members[0].node, "192.0.2.11");
  assertEquals(members[0].member, "a1b2c3d4e5f60718");
  assertEquals(members[0].raftIndex, 14876322);
  assertEquals(members[0].raftTerm, 42);
  assertEquals(members[0].learner, false);
  assertEquals(members[0].errors, "");
  assertEquals(members[2].member, LEADER_ID);
});

test("parseEtcdStatus also reads the ID/PROTOCOL-VERSION column layout", () => {
  const text = `NODE         ID                 PROTOCOL-VERSION   DB SIZE   IN USE           LEADER             RAFT INDEX   RAFT TERM   LEARNER   ERRORS
192.0.2.11   a1b2c3d4e5f60718   3.5.0              131 MB    47 MB (35.88%)   3f9a1b2c3d4e5f60   14876322     42          false
`;
  const members = parseEtcdStatus(text);
  assertEquals(members.length, 1);
  assertEquals(members[0].node, "192.0.2.11");
  assertEquals(members[0].member, "a1b2c3d4e5f60718");
  assertEquals(members[0].raftIndex, 14876322);
  assertEquals(members[0].errors, "");
});

test("parseEtcdStatus returns nothing for an error message instead of a table", () => {
  assertEquals(
    parseEtcdStatus("rpc error: code = Unavailable desc = connection error\n"),
    [],
  );
});

test("etcdHealth accepts three members whose RAFT INDEX is within the tolerance", () => {
  const health = etcdHealth(parseEtcdStatus(ETCD_HEALTHY), 3);
  assertEquals(health.problems, []);
  assertEquals(health.ok, true);
});

test("etcdHealth rejects a member lagging further than --raft-tolerance", () => {
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
    `192.0.2.12 RAFT INDEX 14870001 is 6321 behind 14876322 (tolerance ${DEFAULT_RAFT_TOLERANCE})`,
  );
  // the same table passes with an explicit, wider tolerance
  assertEquals(etcdHealth(parseEtcdStatus(text), 3, 10_000).ok, true);
});

test("etcdHealth rejects a member with a non-empty ERRORS column", () => {
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
  assertEquals(health.problems, ["192.0.2.13: ERRORS etcdserver: no leader"]);
});

test("etcdHealth rejects a missing member, which is exactly the state that loses quorum next", () => {
  const text = etcdTable([
    { node: IPS[0], member: "a1b2c3d4e5f60718", index: "14876322" },
    { node: IPS[2], member: LEADER_ID, index: "14876322" },
  ]);
  const health = etcdHealth(parseEtcdStatus(text), 3);
  assertEquals(health.ok, false);
  assertEquals(health.problems, ["2 member(s) answered, expected 3"]);
});

test("etcdHealth rejects a table where the members disagree about the leader", () => {
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

const DF_ROOT = `Filesystem          1024-blocks     Used Available Capacity Mounted on
/dev/mapper/pve-root   98559220 55993312  37518564      60% /
`;

test("parseDfRootUsePercent reads the Use% of / from df -P", () => {
  assertEquals(parseDfRootUsePercent(DF_ROOT), 60);
});

test("parseDfRootUsePercent reads the 100% root seen during the investigation", () => {
  const full = `Filesystem          1024-blocks     Used Available Capacity Mounted on
/dev/mapper/pve-root   98559220 98559220         0     100% /
`;
  assertEquals(parseDfRootUsePercent(full), 100);
});

test("parseDfRootUsePercent ignores other mount points and unparseable output", () => {
  const other = `Filesystem     1024-blocks      Used Available Capacity Mounted on
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

const ADDRESSES = `NODE         NAMESPACE   TYPE            ID                   VERSION   ADDRESS         LINK
192.0.2.11   network     AddressStatus   eth0/192.0.2.11/24   1         192.0.2.11/24   eth0
192.0.2.12   network     AddressStatus   eth0/192.0.2.12/24   1         192.0.2.12/24   eth0
192.0.2.12   network     AddressStatus   eth0/192.0.2.10/32   1         192.0.2.10/32   eth0
192.0.2.13   network     AddressStatus   eth0/192.0.2.13/24   1         192.0.2.13/24   eth0
`;

test("vipHolders finds the single node carrying the API VIP as a /32", () => {
  assertEquals(vipHolders(ADDRESSES, VIP), ["192.0.2.12"]);
});

test("vipHolders returns nothing while the VIP is moving and both nodes during a split", () => {
  const none = ADDRESSES.split("\n")
    .filter((l) => !l.includes(`${VIP}/32`))
    .join("\n");
  assertEquals(vipHolders(none, VIP), []);
  const both =
    ADDRESSES +
    "192.0.2.13   network     AddressStatus   eth0/192.0.2.10/32   1         192.0.2.10/32   eth0\n";
  assertEquals(vipHolders(both, VIP), ["192.0.2.12", "192.0.2.13"]);
});

test("vipHolders does not match a node IP that merely starts with the VIP", () => {
  const text = `NODE         NAMESPACE   TYPE            ID                    VERSION   ADDRESS          LINK
192.0.2.11   network     AddressStatus   eth0/192.0.2.100/24   1         192.0.2.100/24   eth0
`;
  assertEquals(vipHolders(text, VIP), []);
});

// ----------------------------------------------------------------------------
// pvesm status: does the target datastore exist, and is there room
// ----------------------------------------------------------------------------

const PVESM = `Name             Type     Status           Total            Used       Available        %
cp-storage       zfspool  active       959200000          131072       959068928    0.01%
local            dir      active        98559220        55993312        37518564   56.81%
vm-storage       zfspool  active      1952448512       800123456      1152325056   40.98%
`;

test("parsePvesmStatus reads the datastores and converts KiB to GiB", () => {
  const entries = parsePvesmStatus(PVESM);
  assertEquals(
    entries.map((e) => e.name),
    ["cp-storage", "local", "vm-storage"],
  );
  const cp = findDatastore(entries, "cp-storage");
  assertEquals(cp?.type, "zfspool");
  assertEquals(cp?.status, "active");
  assertEquals(Math.round(cp!.availGiB), 915);
  assertEquals(findDatastore(entries, "nope"), null);
});

test("parsePvesmStatus ignores the header and a disabled datastore's non-numeric row", () => {
  assertEquals(
    parsePvesmStatus("Name Type Status Total Used Available %\n"),
    [],
  );
  assertEquals(parsePvesmStatus(""), []);
});

// ----------------------------------------------------------------------------
// kubectl
// ----------------------------------------------------------------------------

const KUBECTL_NODES = `NAME            STATUS     ROLES           AGE    VERSION   INTERNAL-IP   EXTERNAL-IP   OS-IMAGE          KERNEL-VERSION   CONTAINER-RUNTIME
talos-og0-md2   Ready      control-plane   158d   v1.32.0   192.0.2.11    <none>        Talos (v1.12.2)   6.18.5-talos     containerd://2.1.6
talos-71y-z3h   NotReady   control-plane   158d   v1.32.0   192.0.2.12    <none>        Talos (v1.12.2)   6.18.5-talos     containerd://2.1.6
talos-eml-39s   Ready      control-plane   158d   v1.32.0   192.0.2.13    <none>        Talos (v1.12.2)   6.18.5-talos     containerd://2.1.6
talos-lz1-3u1   Ready      <none>          158d   v1.32.0   192.0.2.21    <none>        Talos (v1.12.2)   6.18.5-talos     containerd://2.1.6
`;

test("isNodeReady matches on internal IP, not the Proxmox VM name", () => {
  const rows = parseKubectlNodes(KUBECTL_NODES);
  assertEquals(rows.length, 4);
  assertEquals(rows[0].name, "talos-og0-md2");
  assertEquals(rows[0].internalIP, "192.0.2.11");
  assertEquals(isNodeReady(rows, "192.0.2.11"), true);
  assertEquals(isNodeReady(rows, "192.0.2.12"), false);
  // An IP with no node at all is not Ready.
  assertEquals(isNodeReady(rows, "192.0.2.99"), false);
  // The regression this test exists for: Kubernetes never knows a node by its
  // Proxmox VM name, so matching on "cp-1" could never settle.
  assertEquals(isNodeReady(rows, "cp-1"), false);
  assertEquals(findKubeNode(rows, "192.0.2.13")?.name, "talos-eml-39s");
});

test("isReadyzOk only accepts a trailing ok", () => {
  assertEquals(isReadyzOk("ok"), true);
  assertEquals(isReadyzOk("ok\n"), true);
  assertEquals(isReadyzOk("[+]etcd ok\nreadyz check failed\n"), false);
  assertEquals(isReadyzOk(""), false);
});

// ----------------------------------------------------------------------------
// flag validation
// ----------------------------------------------------------------------------

test("parseBwlimit accepts KiB/s and refuses junk, zero and negatives", () => {
  assertEquals(parseBwlimit("200000"), 200000);
  assertEquals(parseBwlimit(" 50 "), 50);
  for (const bad of ["", "0", "-1", "200000k", "1.5", "unlimited"]) {
    assertThrows(() => parseBwlimit(bad), UsageError, undefined, bad);
  }
});

test("parsePercent accepts 1..100 and names the flag it rejects", () => {
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

test("parseDuration accepts the timeout shapes the runbook uses", () => {
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

test("formatDuration prints the shortest form", () => {
  assertEquals(formatDuration(300_000), "5m");
  assertEquals(formatDuration(60_000), "1m");
  assertEquals(formatDuration(15_000), "15s");
  assertEquals(formatDuration(250), "250ms");
});

test("buildConfig fills the topology from the environment file", () => {
  const cfg = buildConfig(parseArgs(["migrate", "--yes"], ENV));
  assertEquals(cfg.command, "migrate");
  assertEquals(cfg.yes, true);
  assertEquals(cfg.dryRun, false);
  assertEquals(cfg.ssh, { user: "root", host: "192.0.2.250" });
  assertEquals(cfg.context, "admin@homelab");
  assertEquals(cfg.vip, "192.0.2.10");
  assertEquals(cfg.disk, "scsi0");
  assertEquals(cfg.targetDatastore, "cp-storage");
  assertEquals(cfg.sourceDatastore, "vm-storage");
  assertEquals(cfg.bwlimit, DEFAULT_BWLIMIT);
  assertEquals(cfg.shutdownTimeoutMs, 300_000);
  assertEquals(cfg.settleTimeoutMs, 600_000);
  assertEquals(cfg.settleWaitMs, 60_000);
  assertEquals(cfg.maxRootUse, 90);
  assertEquals(
    cfg.nodes.map((n) => n.name),
    ["cp-1", "cp-2", "cp-3"],
  );
});

test("buildConfig applies --only, --bwlimit and --dry-run", () => {
  const cfg = buildConfig(
    parseArgs(
      [
        "migrate",
        "--dry-run",
        "--only",
        "cp-2",
        "--bwlimit=100000",
        "--settle-wait",
        "30s",
      ],
      ENV,
    ),
  );
  assertEquals(cfg.dryRun, true);
  assertEquals(cfg.bwlimit, 100000);
  assertEquals(cfg.settleWaitMs, 30_000);
  assertEquals(
    cfg.nodes.map((n) => n.vmid),
    [102],
  );
  // --only narrows the work, never the cluster-wide etcd/VIP checks
  assertEquals(cfg.allNodes.length, 3);
});

test("buildConfig refuses a Kind context, an identical source/target and a bad disk", () => {
  assertThrows(
    () =>
      buildConfig(
        parseArgs(["status", "--context", "kind-homelab-localdev"], ENV),
      ),
    UsageError,
    "Kind context",
  );
  assertThrows(
    () =>
      buildConfig(
        parseArgs(["status", "--target-datastore", "vm-storage"], ENV),
      ),
    UsageError,
    "both vm-storage",
  );
  assertThrows(
    () => buildConfig(parseArgs(["status", "--disk", "sda"], ENV)),
    UsageError,
    "--disk",
  );
  assertThrows(
    () => buildConfig(parseArgs(["status", "--vip", "192.0.2"], ENV)),
    UsageError,
    "--vip",
  );
});

// ----------------------------------------------------------------------------
// the topology comes from the environment file, never from this repository
// ----------------------------------------------------------------------------

const ENV_YAML = `DOMAIN: example.test
PROXMOX_IP: ${PROXMOX_HOST}
CP_VIP: ${VIP}
CP1_IP: ${IPS[0]}
CP2_IP: ${IPS[1]}
CP3_IP: ${IPS[2]}
`;

test("envFileValue reads an address and refuses placeholders and junk", () => {
  assertEquals(envFileValue(ENV_YAML, "CP_VIP"), VIP);
  assertEquals(envFileValue(ENV_YAML, "DOMAIN"), "example.test");
  assertEquals(envFileValue(ENV_YAML, "MISSING_KEY"), null);
  assertEquals(envFileValue("CP_VIP: REPLACEME\n", "CP_VIP"), null);
  assertEquals(envFileValue("CP_VIP: ''\n", "CP_VIP"), null);
  assertEquals(envFileValue("CP_VIP: 10\n", "CP_VIP"), null);
  assertEquals(envFileValue("CP_VIP: nonsense\n", "CP_VIP"), null);
  assertEquals(envFileValue(": : not yaml\n", "CP_VIP"), null);
  assertEquals(envFileValue("", "CP_VIP"), null);
});

test("nodesFromEnvFile builds --nodes from the CPn_IP keys the file declares", () => {
  assertEquals(nodesFromEnvFile(ENV_YAML), NODES);
  assertEquals(
    parseNodeSpecs(nodesFromEnvFile(ENV_YAML)!).map((n) => [n.name, n.vmid]),
    [
      ["cp-1", 101],
      ["cp-2", 102],
      ["cp-3", 103],
    ],
  );
});

test("the control-plane key set is read from the file, not fixed at three", () => {
  // ADR-034: the member set is DERIVED from the CPn_IP keys. A fork with one
  // control plane, or with five, must not be reshaped into this cluster's three.
  assertEquals(cpKeysFromEnvFile(ENV_YAML), ["CP1_IP", "CP2_IP", "CP3_IP"]);
  // CP_VIP is the shared virtual IP and the workers are not the control plane;
  // counting either would migrate a node that is not a control plane.
  assertEquals(
    cpKeysFromEnvFile("CP_VIP: 192.0.2.10\nWORKER1_IP: 192.0.2.21\n"),
    [],
  );

  const single = `CP_VIP: ${VIP}\nCP1_IP: ${IPS[0]}\n`;
  assertEquals(nodesFromEnvFile(single), `cp-1=101=${IPS[0]}`);

  // Ordinals need not be contiguous: CP1/CP2/CP5 is three members, not five,
  // and the ordinal — not the position — decides the name and the VMID.
  const sparse = `CP1_IP: ${IPS[0]}\nCP5_IP: ${IPS[1]}\nCP10_IP: ${IPS[2]}\n`;
  assertEquals(
    nodesFromEnvFile(sparse),
    `cp-1=101=${IPS[0]},cp-5=105=${IPS[1]},cp-10=110=${IPS[2]}`,
  );
  // ...in ascending ordinal order, whatever order the file lists them in.
  assertEquals(
    cpKeysFromEnvFile(
      `CP10_IP: ${IPS[2]}\nCP2_IP: ${IPS[1]}\nCP1_IP: ${IPS[0]}\n`,
    ),
    ["CP1_IP", "CP2_IP", "CP10_IP"],
  );
});

test("nodesFromEnvFile refuses a partial control-plane list rather than migrating a subset", () => {
  // A declared key whose value is missing, blank or a placeholder is
  // indeterminate, not absent (contract evaluation.onIndeterminate: unsafe):
  // silently dropping it would migrate a subset of the control planes.
  for (const key of ["CP1_IP", "CP2_IP", "CP3_IP"]) {
    for (const bad of ["", " ''", " REPLACEME"]) {
      const broken = ENV_YAML.replace(
        new RegExp(`^${key}:.*$`, "m"),
        `${key}:${bad}`,
      );
      assertEquals(cpNodeDefaultsFromEnvFile(broken), null, `${key}:${bad}`);
    }
  }
  // CP1_IP is the one required address: without it there is no bootstrap node.
  assertEquals(nodesFromEnvFile(ENV_YAML.replace(/^CP1_IP:.*$/m, "")), null);
  // Dropping an optional higher ordinal is a smaller cluster, not an error.
  assertEquals(
    nodesFromEnvFile(ENV_YAML.replace(/^CP3_IP:.*$/m, "")),
    `cp-1=101=${IPS[0]},cp-2=102=${IPS[1]}`,
  );
  // No CPn_IP key at all states nothing about the control plane.
  assertEquals(nodesFromEnvFile(""), null);
  assertEquals(nodesFromEnvFile("DOMAIN: example.test\n"), null);
});

test("buildConfig names the flag and the config key instead of guessing an address", () => {
  for (const [env, needle] of [
    [{}, "--nodes"],
    [{ nodes: NODES }, "--proxmox-host"],
    [{ nodes: NODES, proxmoxHost: PROXMOX_HOST }, "--vip"],
  ] as [ArgEnv, string][]) {
    const err = assertThrows(
      () => buildConfig(parseArgs(["status"], env)),
      UsageError,
      needle,
    ) as UsageError;
    // it always says which configuration key supplies the missing value
    assertEquals(
      err.message.includes("configuration/environments/homelab.yaml"),
      true,
      err.message,
    );
  }
  // it names CP1_IP and the CPn_IP pattern, not a fixed three-key list: this
  // repository does not know how many control planes the operator's fork has.
  const nodesErr = assertThrows(
    () => buildConfig(parseArgs(["status"], {})),
    UsageError,
  ).message;
  assertEquals(nodesErr.includes("CP1_IP"), true, nodesErr);
  assertEquals(nodesErr.includes("CPn_IP"), true, nodesErr);
  assertEquals(nodesErr.includes("CP3_IP"), false, nodesErr);
});

test("an explicit flag wins over the environment file", () => {
  const cfg = buildConfig(
    parseArgs(
      [
        "status",
        "--nodes",
        "cp-9=109=192.0.2.19",
        "--proxmox-host",
        "proxmox.example.test",
        "--vip",
        "192.0.2.99",
      ],
      ENV,
    ),
  );
  assertEquals(cfg.allNodes, [{ name: "cp-9", vmid: 109, ip: "192.0.2.19" }]);
  assertEquals(cfg.ssh.host, "proxmox.example.test");
  assertEquals(cfg.vip, "192.0.2.99");
});

test("parseArgs rejects unknown subcommands and flags, and treats -h as help", () => {
  assertEquals(parseArgs(["--help"], ENV).command, "help");
  assertEquals(parseArgs([], ENV).command, "help");
  assertEquals(parseArgs(["-h", "migrate"], ENV).command, "help");
  assertThrows(
    () => parseArgs(["rollback"], ENV),
    UsageError,
    "unknown subcommand",
  );
  assertThrows(
    () => parseArgs(["status", "--nope"], ENV),
    UsageError,
    "unknown flag",
  );
  assertThrows(
    () => parseArgs(["status", "--only"], ENV),
    UsageError,
    "needs a value",
  );
  assertThrows(
    () => parseArgs(["status", "extra"], ENV),
    UsageError,
    "unexpected",
  );
});

test("failingGates treats unknown as a failure in a real run but not in a dry run", () => {
  const gates: Gate[] = [
    { name: "a", ok: true, detail: "" },
    { name: "b", ok: null, detail: "" },
    { name: "c", ok: false, detail: "" },
  ];
  assertEquals(
    failingGates(gates, false).map((g) => g.name),
    ["b", "c"],
  );
  assertEquals(
    failingGates(gates, true).map((g) => g.name),
    ["c"],
  );
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
  "root@192.0.2.250",
];

test("qmMoveDiskArgv is exactly the runbook's move-disk command", () => {
  assertEquals(
    qmMoveDiskArgv(SSH, 101, "scsi0", "cp-storage", DEFAULT_BWLIMIT),
    [
      ...SSH_PREFIX,
      "qm move-disk 101 scsi0 cp-storage --delete 1 --bwlimit 200000",
    ],
  );
});

test("qmShutdownArgv, qmStartArgv, qmStopArgv and qmStatusArgv build one qm verb each", () => {
  assertEquals(qmShutdownArgv(SSH, 102), [...SSH_PREFIX, "qm shutdown 102"]);
  assertEquals(qmStartArgv(SSH, 102), [...SSH_PREFIX, "qm start 102"]);
  assertEquals(qmStopArgv(SSH, 103), [...SSH_PREFIX, "qm stop 103"]);
  assertEquals(qmStatusArgv(SSH, 103), [...SSH_PREFIX, "qm status 103"]);
  assertEquals(qmConfigArgv(SSH, 101), [...SSH_PREFIX, "qm config 101"]);
  assertEquals(pvesmStatusArgv(SSH), [...SSH_PREFIX, "pvesm status"]);
  assertEquals(dfRootArgv(SSH), [...SSH_PREFIX, "df -P /"]);
});

test("the ssh user and host are honoured", () => {
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

test("the talosctl and kubectl argv match the runbook", () => {
  assertEquals(talosEtcdStatusArgv(IPS), [
    "talosctl",
    "-n",
    "192.0.2.11,192.0.2.12,192.0.2.13",
    "etcd",
    "status",
  ]);
  assertEquals(talosAddressesArgv(IPS), [
    "talosctl",
    "-n",
    "192.0.2.11,192.0.2.12,192.0.2.13",
    "get",
    "addresses",
  ]);
  assertEquals(talosEtcdSnapshotArgv(IPS[0], "/tmp/etcd.snapshot"), [
    "talosctl",
    "-n",
    "192.0.2.11",
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
    "-o",
    "wide",
  ]);
});

test("snapshotPath names the file after the UTC start of the run", () => {
  assertEquals(
    snapshotPath("./etcd-snapshots", new Date("2026-09-15T18:04:05.123Z")),
    "etcd-snapshots/etcd-20260915T180405Z.snapshot",
  );
  assertEquals(
    snapshotPath("/tmp", new Date("2026-09-15T00:00:00.000Z")),
    "/tmp/etcd-20260915T000000Z.snapshot",
  );
});

test("the node list drives every per-node command", () => {
  const nodes: NodeSpec[] = parseNodeSpecs(NODES);
  assertEquals(
    nodes.map((n) =>
      qmMoveDiskArgv(SSH, n.vmid, "scsi0", "cp-storage", 200000).at(-1),
    ),
    [
      "qm move-disk 101 scsi0 cp-storage --delete 1 --bwlimit 200000",
      "qm move-disk 102 scsi0 cp-storage --delete 1 --bwlimit 200000",
      "qm move-disk 103 scsi0 cp-storage --delete 1 --bwlimit 200000",
    ],
  );
});
