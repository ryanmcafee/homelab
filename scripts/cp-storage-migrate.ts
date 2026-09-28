#!/usr/bin/env bun

/**
 * cp-storage-migrate.ts
 *
 * Moves the three Talos control-plane VM system disks from the shared Proxmox
 * datastore `vm-storage` to the dedicated NVMe pool `cp-storage`, one node at a
 * time, with verification gates between nodes. This automates the "Migration"
 * section (step 2) of docs/runbooks/control-plane-storage.md; read that runbook
 * first. Step 1 (create the datastore, terragrunt) and step 3 (the etcd
 * `extraArgs` tuning, terragrunt, one node per apply) stay manual.
 *
 * This is the one script in this repository that writes to production, so it is
 * gated accordingly: `migrate` refuses to run without --yes, every mutating
 * command goes through a single function (mutate) that cannot run while
 * --dry-run is set, and only one `qm move-disk` is ever in flight (a sequential
 * loop plus a runtime assertion). Agents run `status`, `verify` and --dry-run
 * only (ADR-009).
 *
 * Subcommands:
 *   status   Read-only. Per node: the datastore of its scsi0 disk and the disk
 *            size, the VM state, its etcd member (RAFT INDEX, ERRORS), whether
 *            it holds the API VIP, plus whether the target datastore exists and
 *            how much space it has. Prints a table and says plainly which nodes
 *            still need migrating. Never exits non-zero for "needs migrating".
 *   migrate  For each node still on the source datastore, in order: preflight
 *            gates (a control-plane count the topology contract permits, target
 *            datastore present and large enough, Proxmox root filesystem below
 *            --max-root-use, etcd `whole`, /readyz ok, the VIP held by a node,
 *            an etcd snapshot taken in this run) -> a fresh etcd reading gated
 *            on `survivable` with this node declared as the target -> `qm
 *            shutdown` and poll `qm status` until stopped (--shutdown-timeout)
 *            -> `qm move-disk <vmid> scsi0 <target> --delete 1 --bwlimit` ->
 *            `qm start` -> post gates polled until --settle-timeout (Talos API
 *            answers, etcd `whole` again, /readyz ok, the node Ready, the VIP
 *            held by exactly one node) -> wait --settle-wait -> next node.
 *            Any failure stops the run immediately, prints the state the
 *            cluster is in and points at the runbook's Rollback section. It
 *            never continues to the next node after a failure.
 *   verify   Read-only. Every control-plane disk on the target datastore, etcd
 *            healthy, /readyz ok, the VIP held by exactly one node, and the
 *            kube-etcd scrape (best effort: needs --prometheus-url, otherwise
 *            it prints the runbook's port-forward recipe). Exit 1 if not.
 *
 * Every Proxmox operation is an `ssh <--ssh-user>@<--proxmox-host> 'qm ...'`;
 * talosctl and kubectl are expected on PATH.
 *
 * The etcd safety rule is NOT defined here. contracts/cluster/topology.v1.yaml
 * holds the quorum formula, the health conditions, the named predicates and
 * which predicate guards which evaluation point, and both this script and
 * `homelab talos recreate` read it (ADR-035, ADR-031). This script runs the
 * `fresh` run shape only — preflight, before-destructive-step, completion — and
 * has no `resume` entry point, because it never removes an etcd member: a node
 * it stopped is absent from its own membership, never unrepresented.
 *
 * No address is hardcoded here. --nodes, --vip and --proxmox-host default to
 * the CPn_IP keys, CP_VIP and PROXMOX_IP from the gitignored
 * configuration/environments/homelab.yaml (override the path with
 * HOMELAB_ENV_FILE); an explicit flag always wins, and a value that neither
 * supplies is a usage error rather than a guess.
 *
 * Usage:
 *   task cp:migrate:status
 *   task cp:migrate -- --dry-run
 *   task cp:migrate -- --yes --only cp-1
 *   bun scripts/cp-storage-migrate.ts --help
 *
 * Exit codes: 0 = success; 1 = a gate or a command failed; 2 = argument error.
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isNotFound } from "./lib/errors.ts";
import {
  evaluatePredicate,
  loadTopologyContract,
  type Observation,
  type PointId,
  type Verdict,
} from "./lib/topology-contract.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

/**
 * The etcd quorum and health rule, read from contracts/cluster/topology.v1.yaml
 * rather than restated here (ADR-035, ADR-031). Every number this script uses
 * to decide whether it is safe to stop a control-plane node — the quorum, the
 * tolerated unavailability, the RAFT INDEX tolerance, the observation bounds —
 * and which predicate guards which gate, comes from that file.
 */
export const TOPOLOGY = loadTopologyContract();

/**
 * The contract run shape `migrate` implements. It is `fresh` and only `fresh`:
 * this script stops a control-plane VM and starts it again, and never removes
 * an etcd member, so a node it is working on is absent from etcd's membership
 * and never unrepresented. There is therefore no observation that selects
 * `resume`, and `evaluation.entry: exclusive` — which binds a consumer that
 * runs the destructive removal procedure — does not bind this one. A run that
 * finds a node already stopped refuses at `preflight`, which is the runbook's
 * instruction: recover that node before touching the next.
 */
export const RUN_SHAPE = "fresh";

// ============================================================================
// Logging
// ============================================================================
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.log(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.log(`${green("OK")}    ${msg}`),
  warn: (msg: string) => console.log(`${yellow("WARN")}  ${msg}`),
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
  dry: (msg: string) => console.log(`${yellow("DRY")}   ${msg}`),
};

// ============================================================================
// Constants — the facts from docs/runbooks/control-plane-storage.md
// ============================================================================
export const RUNBOOK = "docs/runbooks/control-plane-storage.md";
export const DEFAULT_SSH_USER = "root";
export const DEFAULT_CONTEXT = "admin@homelab";
export const DEFAULT_TARGET_DATASTORE = "cp-storage";
export const DEFAULT_SOURCE_DATASTORE = "vm-storage";
export const DEFAULT_DISK = "scsi0";
/**
 * The addresses live in the gitignored environment file, never in this
 * repository: --nodes, --proxmox-host and --vip default to its values and the
 * run is refused when they are missing (the same contract as
 * scripts/tailscale-dns.ts and scripts/prod-readonly.ts).
 */
export const HOMELAB_ENV_FILE = "configuration/environments/homelab.yaml";
/**
 * The ConfigSet keys that state the control plane, from
 * contracts/cluster/topology.v1.yaml `controlPlane.countKeyPattern` (ADR-035):
 * the members are the DISTINCT matching keys carrying a value, and there is no
 * count key. Ordinals need not be contiguous — CP1/CP2/CP5 is three members,
 * not five — so nothing here may assume a fixed number of rows.
 */
export const CP_KEY_PATTERN = /^CP([0-9]+)_IP$/;
/**
 * The one control-plane address a fork must supply: `talos:gen` bootstraps from
 * it (Taskfile.yml). Higher ordinals are optional, one per further member.
 */
export const CP_FIRST_KEY = "CP1_IP";
/** How the usage text and the errors below name the key set. */
export const CP_KEY_LABEL = "CPn_IP";
/** configuration key behind --vip: the Talos layer-2 API VIP. */
export const VIP_KEY = "CP_VIP";
/** configuration key behind --proxmox-host. */
export const PROXMOX_HOST_KEY = "PROXMOX_IP";
/** KiB/s. The copy reads from the pool whose saturation causes the outage. */
export const DEFAULT_BWLIMIT = 200000;
export const DEFAULT_SHUTDOWN_TIMEOUT = "5m";
export const DEFAULT_SETTLE_TIMEOUT = "10m";
export const DEFAULT_SETTLE_WAIT = "60s";
export const DEFAULT_POLL_INTERVAL = "15s";
export const DEFAULT_MAX_ROOT_USE = 90;
export const DEFAULT_SNAPSHOT_DIR = "./etcd-snapshots";
/**
 * How far behind the highest RAFT INDEX a member may be and still count as
 * "matching" (the runbook's wording). `health.raftIndexTolerance` in the
 * contract, not a number chosen here: changing it is a contract change
 * (ADR-030).
 */
export const DEFAULT_RAFT_TOLERANCE = TOPOLOGY.raftIndexTolerance;
export const SSH_CONNECT_TIMEOUT = 10;

// ============================================================================
// Pure helpers (unit-tested in cp-storage-migrate_test.ts)
// ============================================================================

/** Raised for invalid invocations; main maps it to exit code 2. */
export class UsageError extends Error {}

const DURATION = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/;
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const NODE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_NAME =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** "30s", "5m", "250ms", "1h" or plain seconds ("90") -> milliseconds. */
export function parseDuration(raw: string, flag = "duration"): number {
  const m = DURATION.exec(raw);
  if (!m) {
    throw new UsageError(
      `--${flag} must look like 30s, 5m or 90 (seconds), got ${JSON.stringify(
        raw,
      )}`,
    );
  }
  const ms = Math.round(Number(m[1]) * UNIT_MS[m[2] ?? "s"]);
  if (!(ms > 0)) throw new UsageError(`--${flag} must be positive, got ${raw}`);
  return ms;
}

/** Milliseconds -> the shortest of "2m", "90s", "250ms". */
export function formatDuration(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms > 0 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** KiB/s for `qm move-disk --bwlimit`: a positive integer. */
export function parseBwlimit(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(
      `--bwlimit must be a whole number of KiB/s like ${DEFAULT_BWLIMIT}, got ${JSON.stringify(
        raw,
      )}`,
    );
  }
  const n = Number(raw.trim());
  if (n < 1) {
    throw new UsageError(
      "--bwlimit must be at least 1 KiB/s (0 = unlimited " +
        "is refused: an unthrottled copy is what this migration avoids)",
    );
  }
  return n;
}

/** A percentage in 1..100 for --max-root-use. */
export function parsePercent(raw: string, flag: string): number {
  if (!/^\d{1,3}$/.test(raw.trim())) {
    throw new UsageError(
      `--${flag} must be a whole percentage like 90, got ${JSON.stringify(
        raw,
      )}`,
    );
  }
  const n = Number(raw.trim());
  if (n < 1 || n > 100) {
    throw new UsageError(`--${flag} must be between 1 and 100, got ${n}`);
  }
  return n;
}

export interface NodeSpec {
  name: string;
  vmid: number;
  ip: string;
}

/**
 * "cp-1=101=192.0.2.11,cp-2=102=..." -> the control planes, in order. The
 * order is the migration order and is preserved.
 */
export function parseNodeSpecs(raw: string): NodeSpec[] {
  const specs = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((entry) => {
      const parts = entry.split("=");
      if (parts.length !== 3) {
        throw new UsageError(
          `--nodes entry ${JSON.stringify(
            entry,
          )} must look like name=vmid=ip (cp-1=101=192.0.2.11)`,
        );
      }
      const [name, vmid, ip] = parts.map((p) => p.trim());
      if (!NODE_NAME.test(name)) {
        throw new UsageError(`invalid node name ${JSON.stringify(name)}`);
      }
      if (!/^\d+$/.test(vmid) || Number(vmid) < 100) {
        throw new UsageError(
          `invalid VMID ${JSON.stringify(
            vmid,
          )} for ${name} (Proxmox VMIDs start at 100)`,
        );
      }
      const m = IPV4.exec(ip);
      if (!m || m.slice(1).some((o) => Number(o) > 255)) {
        throw new UsageError(`invalid IP ${JSON.stringify(ip)} for ${name}`);
      }
      return { name, vmid: Number(vmid), ip };
    });
  if (specs.length === 0) {
    throw new UsageError("--nodes needs at least one node");
  }
  for (const key of ["name", "vmid", "ip"] as const) {
    const seen = new Set<unknown>();
    for (const s of specs) {
      if (seen.has(s[key])) {
        throw new UsageError(`--nodes repeats ${key} ${String(s[key])}`);
      }
      seen.add(s[key]);
    }
  }
  return specs;
}

/**
 * A trimmed, lower-cased string value from the environment YAML, or null when
 * the file does not parse, the key is missing, empty, a REPLACEME placeholder
 * or not a plausible hostname/IP.
 */
export function envFileValue(text: string, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = (parsed as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v.includes("replaceme")) return null;
  if (!IPV4.test(v) && !(v.includes(".") && DNS_NAME.test(v))) return null;
  return v;
}

/** The CPn_IP keys the environment file declares, in ascending ordinal order. */
export function cpKeysFromEnvFile(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed as Record<string, unknown>)
    .filter((k) => CP_KEY_PATTERN.test(k))
    .sort(
      (a, b) =>
        Number(CP_KEY_PATTERN.exec(a)![1]) - Number(CP_KEY_PATTERN.exec(b)![1]),
    );
}

/** One control plane the environment file names, with its default Proxmox identity. */
export interface CpNodeDefault {
  /** The CPn_IP ordinal, e.g. 2 for CP2_IP. Not an index: ordinals may skip. */
  ordinal: number;
  name: string;
  vmid: number;
  key: string;
  ip: string;
}

/**
 * The control planes the environment file names, in migration order, or null
 * when the set is indeterminate.
 *
 * The member set is DERIVED from the CPn_IP keys present (ADR-035) rather than
 * from a fixed table here: a fork is not required to have this cluster's shape,
 * and this repository must not decide how many control planes a fork has.
 *
 * Only the addresses come from the file. `cp-<ordinal>` and VMID `100+ordinal`
 * are this cluster's Proxmox naming convention, used as a *default* an operator
 * overrides with an explicit --nodes; they are not network facts and no guard
 * reads them.
 *
 * Null (refuse, never a partial list) when:
 *   - no CPn_IP key is present at all — nothing states the control plane;
 *   - CP1_IP is absent — it is the one required address;
 *   - a CPn_IP key is present but its value is empty, a REPLACEME placeholder
 *     or not an address. A key present without a usable value is indeterminate,
 *     not absent (contract `evaluation.onIndeterminate: unsafe`); treating it as
 *     absent would quietly migrate a subset of the control planes.
 */
export function cpNodeDefaultsFromEnvFile(
  text: string,
): readonly CpNodeDefault[] | null {
  const keys = cpKeysFromEnvFile(text);
  if (keys.length === 0 || !keys.includes(CP_FIRST_KEY)) return null;
  const nodes: CpNodeDefault[] = [];
  for (const key of keys) {
    const ip = envFileValue(text, key);
    if (ip === null) return null;
    const ordinal = Number(CP_KEY_PATTERN.exec(key)![1]);
    nodes.push({
      ordinal,
      name: `cp-${ordinal}`,
      vmid: 100 + ordinal,
      key,
      ip,
    });
  }
  return nodes;
}

/**
 * The default --nodes spec ("cp-1=101=<CP1_IP>,...") from the environment YAML,
 * or null when cpNodeDefaultsFromEnvFile refuses the set.
 */
export function nodesFromEnvFile(text: string): string | null {
  const nodes = cpNodeDefaultsFromEnvFile(text);
  if (nodes === null) return null;
  return nodes.map((n) => `${n.name}=${n.vmid}=${n.ip}`).join(",");
}

/** --only cp-2 / --only cp-1,cp-3 -> the subset, in --nodes order. */
export function filterNodes(
  nodes: readonly NodeSpec[],
  only: string | undefined,
): NodeSpec[] {
  if (only === undefined) return [...nodes];
  const wanted = only
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (wanted.length === 0) {
    throw new UsageError("--only needs at least one node");
  }
  const known = new Set(nodes.map((n) => n.name));
  for (const w of wanted) {
    if (!known.has(w)) {
      throw new UsageError(
        `--only ${JSON.stringify(w)} is not a known node (${nodes
          .map((n) => n.name)
          .join(", ")})`,
      );
    }
  }
  const set = new Set(wanted);
  return nodes.filter((n) => set.has(n.name));
}

export interface DiskLocation {
  /** The Proxmox datastore holding the volume, e.g. "vm-storage". */
  datastore: string;
  /** The volume id, e.g. "vm-101-disk-0". */
  volume: string;
  /** size=64G -> 64; null when qm config did not report a size. */
  sizeGiB: number | null;
  raw: string;
}

/** "64G", "65536M", "1T", "1024" (MiB, Proxmox's unitless default) -> GiB. */
export function parseSizeToGiB(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP])?$/i.exec(raw.trim());
  if (!m) return null;
  const factor: Record<string, number> = {
    K: 1 / 1048576,
    M: 1 / 1024,
    G: 1,
    T: 1024,
    P: 1048576,
  };
  return Number(m[1]) * factor[(m[2] ?? "M").toUpperCase()];
}

/**
 * The `scsi0:` line of `qm config <vmid>`:
 *   scsi0: vm-storage:vm-101-disk-0,iothread=1,size=64G,ssd=1
 */
export function parseQmConfigDisk(
  text: string,
  disk: string,
): DiskLocation | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${disk}:`)) continue;
    const value = trimmed.slice(disk.length + 1).trim();
    const [volumeRef, ...options] = value.split(",");
    const colon = volumeRef.indexOf(":");
    if (colon <= 0) return null;
    const sizeOpt = options
      .map((o) => o.trim())
      .find((o) => o.startsWith("size="));
    return {
      datastore: volumeRef.slice(0, colon),
      volume: volumeRef.slice(colon + 1),
      sizeGiB: sizeOpt ? parseSizeToGiB(sizeOpt.slice("size=".length)) : null,
      raw: trimmed,
    };
  }
  return null;
}

/** A disk still needs migrating unless it is already on the target datastore. */
export function needsMigration(
  disk: DiskLocation | null,
  target: string,
): boolean {
  return disk === null ? false : disk.datastore !== target;
}

export type VmState = "running" | "stopped" | "paused" | "unknown";

/** `qm status <vmid>` -> "status: running". */
export function parseQmStatus(text: string): VmState {
  const m = /^\s*status:\s*(\S+)/m.exec(text);
  if (!m) return "unknown";
  const s = m[1].toLowerCase();
  return s === "running" || s === "stopped" || s === "paused" ? s : "unknown";
}

export interface EtcdMember {
  node: string;
  member: string;
  leader: string;
  raftIndex: number;
  raftTerm: number;
  learner: boolean;
  errors: string;
}

/**
 * Column start offsets of a tabwriter header line, keyed by header name.
 * Header names may contain single spaces ("RAFT INDEX", "DB SIZE"), so the
 * cells are split on runs of two or more spaces.
 */
function headerOffsets(header: string): { name: string; start: number }[] {
  const cells: { name: string; start: number }[] = [];
  let pos = 0;
  for (const name of header.trim().split(/\s{2,}/)) {
    const start = header.indexOf(name, pos);
    cells.push({ name, start });
    pos = start + name.length;
  }
  return cells;
}

/**
 * `talosctl -n a,b,c etcd status` (a tabwriter table). Understands both the
 * MEMBER and the ID/PROTOCOL-VERSION column layouts; ERRORS is often empty.
 */
export function parseEtcdStatus(text: string): EtcdMember[] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const headerIdx = lines.findIndex(
    (l) => /\bNODE\b/.test(l) && /\bRAFT INDEX\b/.test(l),
  );
  if (headerIdx < 0) return [];
  const cells = headerOffsets(lines[headerIdx]);
  const cell = (line: string, name: string): string => {
    const i = cells.findIndex((c) => c.name === name);
    if (i < 0) return "";
    const end = i + 1 < cells.length ? cells[i + 1].start : line.length;
    return line.slice(cells[i].start, end).trim();
  };
  const memberName = cells.some((c) => c.name === "MEMBER") ? "MEMBER" : "ID";
  const members: EtcdMember[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const node = cell(line, "NODE");
    if (!node) continue;
    const raftIndex = Number(cell(line, "RAFT INDEX"));
    members.push({
      node,
      member: cell(line, memberName),
      leader: cell(line, "LEADER"),
      raftIndex: Number.isFinite(raftIndex) ? raftIndex : NaN,
      raftTerm: Number(cell(line, "RAFT TERM")),
      learner: cell(line, "LEARNER").toLowerCase() === "true",
      errors: cell(line, "ERRORS"),
    });
  }
  return members;
}

/** One row of `talosctl etcd members` — etcd's own membership. */
export interface EtcdMembership {
  node: string;
  id: string;
  hostname: string;
  peerUrls: string[];
  clientUrls: string[];
  learner: boolean;
}

/**
 * `talosctl -n a,b,c etcd members` (a tabwriter table). This is the observed
 * member set the contract requires (`health.memberSetSource`): a member this
 * table lists but `etcd status` does not is absent, and a configured address
 * with no row here is unrepresented. Reading the dialled addresses instead
 * makes `member-count` a tautology that validates its own derivation.
 */
export function parseEtcdMembers(text: string): EtcdMembership[] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const headerIdx = lines.findIndex(
    (l) => /\bNODE\b/.test(l) && /\bID\b/.test(l) && /\bPEER URLS\b/.test(l),
  );
  if (headerIdx < 0) return [];
  const cells = headerOffsets(lines[headerIdx]);
  const cell = (line: string, name: string): string => {
    const i = cells.findIndex((c) => c.name === name);
    if (i < 0) return "";
    const end = i + 1 < cells.length ? cells[i + 1].start : line.length;
    return line.slice(cells[i].start, end).trim();
  };
  const urls = (s: string): string[] =>
    s
      .split(",")
      .map((u) => u.trim())
      .filter((u) => u !== "");
  const out: EtcdMembership[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const id = cell(line, "ID");
    if (!id) continue;
    out.push({
      node: cell(line, "NODE"),
      id,
      hostname: cell(line, "HOSTNAME"),
      peerUrls: urls(cell(line, "PEER URLS")),
      clientUrls: urls(cell(line, "CLIENT URLS")),
      learner: cell(line, "LEARNER").toLowerCase() === "true",
    });
  }
  return out;
}

/**
 * The address backing each member, from its first parseable peer URL. A member
 * with no usable peer URL is dropped, which shrinks the observed membership and
 * therefore fails `member-count` rather than passing quietly.
 */
export function membershipAddresses(
  members: readonly EtcdMembership[],
): string[] {
  const out: string[] = [];
  for (const m of members) {
    for (const raw of m.peerUrls) {
      const host = urlHost(raw);
      if (host !== null) {
        out.push(host);
        break;
      }
    }
  }
  return out;
}

/** The host of a peer/client URL, without the scheme or port. */
function urlHost(raw: string): string | null {
  try {
    const host = new URL(raw).hostname;
    // An IPv6 literal arrives bracketed; the ConfigSet stores it unbracketed.
    return host.startsWith("[") && host.endsWith("]")
      ? host.slice(1, -1)
      : host || null;
  } catch {
    return null;
  }
}

/** `df -P /` -> the Use% of the root filesystem, or null. */
export function parseDfRootUsePercent(text: string): number | null {
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || fields[fields.length - 1] !== "/") continue;
    const pct = fields[fields.length - 2];
    const m = /^(\d{1,3})%$/.exec(pct);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * `talosctl -n a,b,c get addresses` -> the nodes carrying the VIP as a /32.
 * Exactly one node holds it at a time; it moves when that VM stops.
 */
export function vipHolders(text: string, vip: string): string[] {
  const holders: string[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2 || fields[0] === "NODE") continue;
    if (fields.some((f) => f === `${vip}/32`)) {
      if (!holders.includes(fields[0])) holders.push(fields[0]);
    }
  }
  return holders;
}

export interface StorageEntry {
  name: string;
  type: string;
  status: string;
  totalGiB: number;
  usedGiB: number;
  availGiB: number;
}

/** `pvesm status` (values in KiB) -> one entry per datastore. */
export function parsePvesmStatus(text: string): StorageEntry[] {
  const entries: StorageEntry[] = [];
  const KIB_PER_GIB = 1048576;
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 7 || f[0] === "Name") continue;
    const [name, type, status, total, used, avail] = f;
    if (!/^\d+$/.test(total) || !/^\d+$/.test(avail)) continue;
    entries.push({
      name,
      type,
      status,
      totalGiB: Number(total) / KIB_PER_GIB,
      usedGiB: Number(used) / KIB_PER_GIB,
      availGiB: Number(avail) / KIB_PER_GIB,
    });
  }
  return entries;
}

export function findDatastore(
  entries: StorageEntry[],
  name: string,
): StorageEntry | null {
  return entries.find((e) => e.name === name) ?? null;
}

export interface KubeNodeRow {
  name: string;
  status: string;
  /** INTERNAL-IP from `-o wide`; "" when the column is absent. */
  internalIP: string;
}

/** `kubectl get nodes -o wide` -> NAME, STATUS and INTERNAL-IP. */
export function parseKubectlNodes(text: string): KubeNodeRow[] {
  const rows: KubeNodeRow[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 2 || f[0] === "NAME" || f[0] === "") continue;
    // NAME STATUS ROLES AGE VERSION INTERNAL-IP ...
    rows.push({ name: f[0], status: f[1], internalIP: f[5] ?? "" });
  }
  return rows;
}

/** Find a node by its internal IP; see kubectlNodesArgv for why not by name. */
export function findKubeNode(
  rows: KubeNodeRow[],
  ip: string,
): KubeNodeRow | undefined {
  return rows.find((r) => r.internalIP === ip);
}

export function isNodeReady(rows: KubeNodeRow[], ip: string): boolean {
  return findKubeNode(rows, ip)?.status === "Ready";
}

/** `kubectl get --raw /readyz` -> "ok". */
export function isReadyzOk(text: string): boolean {
  return text.trim().split("\n").pop()?.trim() === "ok";
}

// ----------------------------------------------------------------------------
// Command builders — the exact argv of every remote call
// ----------------------------------------------------------------------------

export interface SshTarget {
  user: string;
  host: string;
}

/** ssh with batch mode so a missing key fails instead of prompting. */
export function sshArgv(target: SshTarget, remote: string): string[] {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    `${target.user}@${target.host}`,
    remote,
  ];
}

export const qmConfigArgv = (t: SshTarget, vmid: number): string[] =>
  sshArgv(t, `qm config ${vmid}`);
export const qmStatusArgv = (t: SshTarget, vmid: number): string[] =>
  sshArgv(t, `qm status ${vmid}`);
export const pvesmStatusArgv = (t: SshTarget): string[] =>
  sshArgv(t, "pvesm status");
export const dfRootArgv = (t: SshTarget): string[] => sshArgv(t, "df -P /");

/** Graceful guest shutdown; `migrate` polls `qm status` for "stopped". */
export const qmShutdownArgv = (t: SshTarget, vmid: number): string[] =>
  sshArgv(t, `qm shutdown ${vmid}`);
/** Only ever used with --force-stop, after a shutdown timed out. */
export const qmStopArgv = (t: SshTarget, vmid: number): string[] =>
  sshArgv(t, `qm stop ${vmid}`);
export const qmStartArgv = (t: SshTarget, vmid: number): string[] =>
  sshArgv(t, `qm start ${vmid}`);

/** The one command that copies the disk. --delete 1 removes the source volume. */
export function qmMoveDiskArgv(
  t: SshTarget,
  vmid: number,
  disk: string,
  target: string,
  bwlimit: number,
): string[] {
  return sshArgv(
    t,
    `qm move-disk ${vmid} ${disk} ${target} --delete 1 --bwlimit ${bwlimit}`,
  );
}

export const talosEtcdStatusArgv = (ips: readonly string[]): string[] => [
  "talosctl",
  "-n",
  ips.join(","),
  "etcd",
  "status",
];
export const talosEtcdMembersArgv = (ips: readonly string[]): string[] => [
  "talosctl",
  "-n",
  ips.join(","),
  "etcd",
  "members",
];
export const talosAddressesArgv = (ips: readonly string[]): string[] => [
  "talosctl",
  "-n",
  ips.join(","),
  "get",
  "addresses",
];
export const talosVersionArgv = (ip: string): string[] => [
  "talosctl",
  "-n",
  ip,
  "version",
];
export const talosEtcdSnapshotArgv = (ip: string, path: string): string[] => [
  "talosctl",
  "-n",
  ip,
  "etcd",
  "snapshot",
  path,
];
export const kubectlReadyzArgv = (context: string): string[] => [
  "kubectl",
  "--context",
  context,
  "get",
  "--raw",
  "/readyz",
];
export const kubectlNodesArgv = (context: string): string[] => [
  "kubectl",
  "--context",
  context,
  "get",
  "nodes",
  // -o wide for INTERNAL-IP: Kubernetes knows a node by its Talos hostname
  // (talos-og0-md2), never by the Proxmox VM name (cp-1), so the IP is the
  // only reliable join between a NodeSpec and its Kubernetes node.
  "-o",
  "wide",
];

/** The etcd snapshot file name for a run started at `at`. */
export function snapshotPath(dir: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return join(dir, `etcd-${stamp}.snapshot`);
}

/** Plain aligned table. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

// ----------------------------------------------------------------------------
// argv
// ----------------------------------------------------------------------------

export type Command = "status" | "migrate" | "verify" | "help";

export interface Args {
  command: Command;
  dryRun: boolean;
  yes: boolean;
  only?: string;
  /** undefined = neither --nodes nor the environment file supplied one. */
  nodes?: string;
  proxmoxHost?: string;
  sshUser: string;
  context: string;
  vip?: string;
  disk: string;
  targetDatastore: string;
  sourceDatastore: string;
  bwlimit: string;
  shutdownTimeout: string;
  settleTimeout: string;
  settleWait: string;
  pollInterval: string;
  maxRootUse: string;
  raftTolerance: string;
  snapshotDir: string;
  skipSnapshot: boolean;
  forceStop: boolean;
  noWait: boolean;
  noProbe: boolean;
  prometheusUrl?: string;
}

const VALUE_FLAGS = new Set([
  "--only",
  "--nodes",
  "--proxmox-host",
  "--ssh-user",
  "--context",
  "--vip",
  "--disk",
  "--target-datastore",
  "--source-datastore",
  "--bwlimit",
  "--shutdown-timeout",
  "--settle-timeout",
  "--settle-wait",
  "--poll-interval",
  "--max-root-use",
  "--raft-tolerance",
  "--snapshot-dir",
  "--prometheus-url",
]);

/** Defaults taken from configuration/environments/homelab.yaml. */
export interface ArgEnv {
  nodes?: string;
  proxmoxHost?: string;
  vip?: string;
}

/**
 * Parses argv. Throws UsageError on anything invalid. Explicit flags always win
 * over `env`, which carries the environment file's values (absent when the file
 * is missing or the key is unset; buildConfig then refuses to guess).
 */
export function parseArgs(argv: string[], env: ArgEnv): Args {
  const args: Args = {
    command: "help",
    dryRun: false,
    yes: false,
    nodes: env.nodes,
    proxmoxHost: env.proxmoxHost,
    sshUser: DEFAULT_SSH_USER,
    context: DEFAULT_CONTEXT,
    vip: env.vip,
    disk: DEFAULT_DISK,
    targetDatastore: DEFAULT_TARGET_DATASTORE,
    sourceDatastore: DEFAULT_SOURCE_DATASTORE,
    bwlimit: String(DEFAULT_BWLIMIT),
    shutdownTimeout: DEFAULT_SHUTDOWN_TIMEOUT,
    settleTimeout: DEFAULT_SETTLE_TIMEOUT,
    settleWait: DEFAULT_SETTLE_WAIT,
    pollInterval: DEFAULT_POLL_INTERVAL,
    maxRootUse: String(DEFAULT_MAX_ROOT_USE),
    raftTolerance: String(DEFAULT_RAFT_TOLERANCE),
    snapshotDir: DEFAULT_SNAPSHOT_DIR,
    skipSnapshot: false,
    forceStop: false,
    noWait: false,
    noProbe: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") return { ...args, command: "help" };
    switch (arg) {
      case "--dry-run":
        args.dryRun = true;
        continue;
      case "--yes":
        args.yes = true;
        continue;
      case "--skip-snapshot":
        args.skipSnapshot = true;
        continue;
      case "--force-stop":
        args.forceStop = true;
        continue;
      case "--no-wait":
        args.noWait = true;
        continue;
      case "--no-probe":
        args.noProbe = true;
        continue;
    }
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (VALUE_FLAGS.has(arg)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined || value.startsWith("--")) {
          throw new UsageError(`${arg} needs a value`);
        }
      }
      switch (arg) {
        case "--only":
          args.only = value;
          break;
        case "--nodes":
          args.nodes = value;
          break;
        case "--proxmox-host":
          args.proxmoxHost = value;
          break;
        case "--ssh-user":
          args.sshUser = value;
          break;
        case "--context":
          args.context = value;
          break;
        case "--vip":
          args.vip = value;
          break;
        case "--disk":
          args.disk = value;
          break;
        case "--target-datastore":
          args.targetDatastore = value;
          break;
        case "--source-datastore":
          args.sourceDatastore = value;
          break;
        case "--bwlimit":
          args.bwlimit = value;
          break;
        case "--shutdown-timeout":
          args.shutdownTimeout = value;
          break;
        case "--settle-timeout":
          args.settleTimeout = value;
          break;
        case "--settle-wait":
          args.settleWait = value;
          break;
        case "--poll-interval":
          args.pollInterval = value;
          break;
        case "--max-root-use":
          args.maxRootUse = value;
          break;
        case "--raft-tolerance":
          args.raftTolerance = value;
          break;
        case "--snapshot-dir":
          args.snapshotDir = value;
          break;
        case "--prometheus-url":
          args.prometheusUrl = value;
          break;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}`);
    positional.push(arg);
  }

  const [command, ...rest] = positional;
  if (command === undefined) return args;
  if (command !== "status" && command !== "migrate" && command !== "verify") {
    throw new UsageError(
      `unknown subcommand ${JSON.stringify(command)} (status, migrate, verify)`,
    );
  }
  if (rest.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  }
  args.command = command;
  return args;
}

export interface Config {
  command: Command;
  dryRun: boolean;
  yes: boolean;
  nodes: NodeSpec[];
  allNodes: NodeSpec[];
  ssh: SshTarget;
  context: string;
  vip: string;
  disk: string;
  targetDatastore: string;
  sourceDatastore: string;
  bwlimit: number;
  shutdownTimeoutMs: number;
  settleTimeoutMs: number;
  settleWaitMs: number;
  pollIntervalMs: number;
  maxRootUse: number;
  raftTolerance: number;
  snapshotDir: string;
  skipSnapshot: boolean;
  forceStop: boolean;
  noWait: boolean;
  noProbe: boolean;
  prometheusUrl?: string;
}

/** Validates and converts the parsed flags. Pure. */
export function buildConfig(args: Args): Config {
  if (args.nodes === undefined) {
    throw new UsageError(
      `--nodes is required (or fill ${CP_FIRST_KEY}, and one further ` +
        `${CP_KEY_LABEL} key per additional control plane, in ${HOMELAB_ENV_FILE})`,
    );
  }
  if (args.proxmoxHost === undefined) {
    throw new UsageError(
      `--proxmox-host is required (or fill ${PROXMOX_HOST_KEY} in ${HOMELAB_ENV_FILE})`,
    );
  }
  if (args.vip === undefined) {
    throw new UsageError(
      `--vip is required (or fill ${VIP_KEY} in ${HOMELAB_ENV_FILE})`,
    );
  }
  const allNodes = parseNodeSpecs(args.nodes);
  if (!IPV4.test(args.vip)) {
    throw new UsageError(`--vip must be an IPv4 address, got ${args.vip}`);
  }
  if (!/^[a-z]+\d+$/.test(args.disk)) {
    throw new UsageError(
      `--disk must look like scsi0 or virtio0, got ${JSON.stringify(
        args.disk,
      )}`,
    );
  }
  if (args.targetDatastore === args.sourceDatastore) {
    throw new UsageError(
      `--target-datastore and --source-datastore are both ${args.targetDatastore}`,
    );
  }
  if (args.context.startsWith("kind-")) {
    throw new UsageError(
      `--context ${args.context} is a Kind context; this script migrates the homelab control planes`,
    );
  }
  if (!/^\d{1,4}$/.test(args.raftTolerance)) {
    throw new UsageError(
      `--raft-tolerance must be a whole number, got ${args.raftTolerance}`,
    );
  }
  return {
    command: args.command,
    dryRun: args.dryRun,
    yes: args.yes,
    nodes: filterNodes(allNodes, args.only),
    allNodes,
    ssh: { user: args.sshUser, host: args.proxmoxHost },
    context: args.context,
    vip: args.vip,
    disk: args.disk,
    targetDatastore: args.targetDatastore,
    sourceDatastore: args.sourceDatastore,
    bwlimit: parseBwlimit(args.bwlimit),
    shutdownTimeoutMs: parseDuration(args.shutdownTimeout, "shutdown-timeout"),
    settleTimeoutMs: parseDuration(args.settleTimeout, "settle-timeout"),
    settleWaitMs: parseDuration(args.settleWait, "settle-wait"),
    pollIntervalMs: parseDuration(args.pollInterval, "poll-interval"),
    maxRootUse: parsePercent(args.maxRootUse, "max-root-use"),
    raftTolerance: Number(args.raftTolerance),
    snapshotDir: args.snapshotDir,
    skipSnapshot: args.skipSnapshot,
    forceStop: args.forceStop,
    noWait: args.noWait,
    noProbe: args.noProbe,
    prometheusUrl: args.prometheusUrl,
  };
}

export interface Gate {
  name: string;
  /** null = could not be determined (nothing was read). */
  ok: boolean | null;
  detail: string;
}

/** The gates that are not satisfied: false, or unknown in a real run. */
export function failingGates(gates: Gate[], dryRun: boolean): Gate[] {
  return gates.filter((g) => g.ok === false || (g.ok === null && !dryRun));
}

/**
 * The etcd gate at one of the contract's evaluation points.
 *
 * The predicate is `TOPOLOGY.predicateAt(point)` — never chosen here. Getting
 * this wrong in either direction is a one-line edit: `whole` immediately before
 * the destructive step aborts every procedure mid-flight, and `survivable` at
 * the door consents to starting on a control plane that was already a member
 * short. `declared` is the address this step has declared it will take away,
 * which is the only absence `survivable` forgives.
 *
 * `observation === null` means nothing was read, which is indeterminate and so
 * `ok: null` — a real run treats that as a failure (`failingGates`).
 */
export function etcdGate(
  point: PointId,
  observation: Observation | null,
  readError?: string,
): Gate {
  const predicate = TOPOLOGY.predicateAt(point);
  const name = `etcd is ${predicate.id} at ${point}`;
  if (observation === null) {
    return { name, ok: null, detail: readError ?? "unknown" };
  }
  const verdict = evaluatePredicate(TOPOLOGY, predicate, observation);
  return {
    name,
    ok: verdict.ok,
    detail: verdict.ok
      ? etcdPassDetail(verdict, observation)
      : problems(verdict),
  };
}

function problems(verdict: Verdict): string {
  return verdict.problems.join("; ");
}

function etcdPassDetail(verdict: Verdict, observation: Observation): string {
  const count = observation.expected.length;
  const parts = [
    `${verdict.answered} of ${count} member(s) answered`,
    `quorum ${TOPOLOGY.quorum(count)}`,
    `at most ${TOPOLOGY.maxUnavailable(count)} may be unavailable`,
    `RAFT INDEX within ${TOPOLOGY.raftIndexTolerance}`,
    "no ERRORS",
  ];
  if (verdict.absent.length > 0) {
    parts.push(`declared target(s) absent: ${verdict.absent.join(", ")}`);
  }
  return parts.join(", ");
}

/**
 * The topology gate: the derived control-plane count is one the contract
 * permits, and an operator on a count the contract calls degraded is told so
 * rather than shown a healthy-looking table.
 *
 * A degraded count is permitted, not healthy — a one-node homelab is a real
 * fork — but stopping the only member of a control plane whose
 * `maxUnavailable` is 0 is a full API-server outage for the duration of the
 * disk copy, not a rolling migration.
 */
export function topologyGate(count: number): Gate {
  const name = "the control-plane count is a topology the contract permits";
  const { degraded, error } = TOPOLOGY.checkCount(count);
  if (error !== null) return { name, ok: false, detail: error };
  const maxUnavailable = TOPOLOGY.maxUnavailable(count);
  if (degraded || maxUnavailable === 0) {
    return {
      name,
      ok: true,
      detail:
        `${count} member(s): permitted but DEGRADED — quorum ${TOPOLOGY.quorum(count)}, at most ` +
        `${maxUnavailable} may be unavailable, so stopping one node is a full API outage for the ` +
        `duration of the disk copy, not a rolling migration. Take the snapshot (do not pass ` +
        `--skip-snapshot) and expect downtime; see ${RUNBOOK}`,
    };
  }
  return {
    name,
    ok: true,
    detail:
      `${count} member(s): quorum ${TOPOLOGY.quorum(count)}, at most ${maxUnavailable} may be ` +
      "unavailable, so one node at a time keeps quorum",
  };
}

// ============================================================================
// Side effects
// ============================================================================

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when nothing was executed (--no-probe). */
  skipped?: boolean;
}

const SKIPPED: RunResult = {
  code: -1,
  stdout: "",
  stderr: "not executed (--no-probe)",
  skipped: true,
};

async function exec(
  cmd: string[],
  stream = false,
  timeoutMs?: number,
): Promise<RunResult> {
  try {
    const child = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: stream ? "inherit" : "pipe",
      stderr: stream ? "inherit" : "pipe",
    });
    // A read with no deadline can block indefinitely on a wedged endpoint and
    // then be acted on as though it were current. Killing the child is what
    // turns that into a reported failure to observe.
    const timer =
      timeoutMs === undefined
        ? null
        : setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        child.stdout ? new Response(child.stdout).text() : "",
        child.stderr ? new Response(child.stderr).text() : "",
        child.exited,
      ]);
      if (timer !== null && child.signalCode === "SIGKILL") {
        return {
          code: code === 0 ? 1 : code,
          stdout: "",
          stderr: `${cmd[0]}: no answer within ${formatDuration(timeoutMs ?? 0)}`,
        };
      }
      return {
        code,
        stdout: stream ? "" : stdout,
        stderr: stream ? "" : stderr,
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  } catch (err) {
    if (isNotFound(err)) {
      return {
        code: 127,
        stdout: "",
        stderr: `${cmd[0]}: command not found on PATH`,
      };
    }
    throw err;
  }
}

/**
 * Every read-only call. Safe in a dry run (it reads), and skipped entirely
 * with --no-probe so the plan can be reviewed without touching anything.
 */
async function read(
  cfg: Config,
  cmd: string[],
  timeoutMs?: number,
): Promise<RunResult> {
  if (cfg.noProbe) return SKIPPED;
  return await exec(cmd, false, timeoutMs);
}

export type MutationKind =
  | "shutdown"
  | "stop"
  | "move-disk"
  | "start"
  | "snapshot";

/** Set for the duration of a move-disk; see the assertion in mutate(). */
let moveDiskInFlight = false;
/** Every mutation this run performed or (in a dry run) would perform. */
const mutations: { kind: MutationKind; cmd: string[]; dryRun: boolean }[] = [];

/**
 * The ONLY function that runs a command able to change anything: the four
 * `qm` verbs and the etcd snapshot. It refuses outright while --dry-run is
 * set, so the safety property is one function wide — mirroring how
 * apiserver-stress.ts funnels every request through getOnce().
 *
 * Returns null in a dry run (the command is printed, not executed).
 */
async function mutate(
  cfg: Config,
  kind: MutationKind,
  cmd: string[],
  stream = false,
): Promise<RunResult | null> {
  mutations.push({ kind, cmd, dryRun: cfg.dryRun });
  if (cfg.dryRun) {
    log.dry(cmd.join(" "));
    return null;
  }
  if (kind === "move-disk") {
    // One disk copy at a time, structurally (a sequential loop) and here.
    if (moveDiskInFlight) {
      throw new Error(
        "internal: a second qm move-disk was started while one was running",
      );
    }
    moveDiskInFlight = true;
  }
  try {
    log.info(`run: ${cmd.join(" ")}`);
    return await exec(cmd, stream);
  } finally {
    if (kind === "move-disk") moveDiskInFlight = false;
  }
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

interface NodeState {
  spec: NodeSpec;
  disk: DiskLocation | null;
  diskError?: string;
  vm: VmState;
  vmError?: string;
}

interface ClusterState {
  nodes: NodeState[];
  /**
   * What the etcd reads saw, as the contract's observation: the derived
   * addresses, etcd's own membership and the statuses that answered. Null when
   * nothing was read, which is indeterminate rather than empty.
   */
  etcd: Observation | null;
  etcdError?: string;
  vipHolders: string[] | null;
  vipError?: string;
  readyz: boolean | null;
  readyzError?: string;
  datastore: StorageEntry | null;
  /** True when `pvesm status` was read: only then is a null datastore a fact. */
  datastoreKnown: boolean;
  datastoreError?: string;
  rootUsePct: number | null;
  rootError?: string;
  kubeNodes: KubeNodeRow[] | null;
}

function short(res: RunResult): string {
  return (res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`)
    .split("\n")[0]
    .slice(0, 160);
}

/** One full read-only sweep of the cluster and the Proxmox host. */
async function gather(cfg: Config): Promise<ClusterState> {
  const state: ClusterState = {
    nodes: [],
    etcd: null,
    vipHolders: null,
    readyz: null,
    datastore: null,
    datastoreKnown: false,
    rootUsePct: null,
    kubeNodes: null,
  };

  for (const spec of cfg.allNodes) {
    const node: NodeState = { spec, disk: null, vm: "unknown" };
    const config = await read(cfg, qmConfigArgv(cfg.ssh, spec.vmid));
    if (config.skipped) {
      node.diskError = "not read (--no-probe)";
    } else if (config.code !== 0) {
      node.diskError = short(config);
    } else {
      node.disk = parseQmConfigDisk(config.stdout, cfg.disk);
      if (!node.disk) {
        node.diskError = `no ${cfg.disk} line in qm config ${spec.vmid}`;
      }
    }
    const status = await read(cfg, qmStatusArgv(cfg.ssh, spec.vmid));
    if (status.skipped) node.vmError = "not read (--no-probe)";
    else if (status.code !== 0) node.vmError = short(status);
    else node.vm = parseQmStatus(status.stdout);
    state.nodes.push(node);
  }

  const ips = cfg.allNodes.map((n) => n.ip);
  const addresses = await read(cfg, talosAddressesArgv(ips));
  if (addresses.skipped) state.vipError = "not read (--no-probe)";
  else if (addresses.code !== 0) state.vipError = short(addresses);
  else state.vipHolders = vipHolders(addresses.stdout, cfg.vip);

  const readyz = await read(cfg, kubectlReadyzArgv(cfg.context));
  if (readyz.skipped) state.readyzError = "not read (--no-probe)";
  else if (readyz.code !== 0) state.readyzError = short(readyz);
  else state.readyz = isReadyzOk(readyz.stdout);

  const nodes = await read(cfg, kubectlNodesArgv(cfg.context));
  if (!nodes.skipped && nodes.code === 0) {
    state.kubeNodes = parseKubectlNodes(nodes.stdout);
  }

  const pvesm = await read(cfg, pvesmStatusArgv(cfg.ssh));
  if (pvesm.skipped) state.datastoreError = "not read (--no-probe)";
  else if (pvesm.code !== 0) state.datastoreError = short(pvesm);
  else {
    state.datastoreKnown = true;
    state.datastore = findDatastore(
      parsePvesmStatus(pvesm.stdout),
      cfg.targetDatastore,
    );
    if (!state.datastore) {
      state.datastoreError =
        `datastore ${cfg.targetDatastore} is not registered on the Proxmox host ` +
        `(runbook step 1: task tf:apply:component COMPONENT=proxmox-zfs-pool-cp)`;
    }
  }

  const df = await read(cfg, dfRootArgv(cfg.ssh));
  if (df.skipped) state.rootError = "not read (--no-probe)";
  else if (df.code !== 0) state.rootError = short(df);
  else {
    state.rootUsePct = parseDfRootUsePercent(df.stdout);
    if (state.rootUsePct === null) state.rootError = "could not parse df -P /";
  }

  // Last, and on purpose. The gates are evaluated right after gather() returns,
  // and `evaluation.maxObservationAgeSeconds` bounds how old a reading may be
  // when it is acted on — a sweep that spent a minute on ssh must not hand a
  // stale etcd reading to a gate that then stops a node.
  const etcd = await observeEtcd(
    cfg,
    cfg.allNodes.map((n) => n.ip),
  );
  state.etcd = etcd.observation;
  if (etcd.error !== null) state.etcdError = etcd.error;
  return state;
}

/**
 * One bounded read of etcd's membership and status, as the contract's
 * observation. `evaluation.observationDeadlineSeconds` bounds the whole read:
 * exceeding it is a failure to observe, which is indeterminate — never "no
 * members". A dial or deadline failure is reported as the transport fault it
 * is, never flattened into a member count
 * (`evaluation.transportFailureIsNotMemberFailure`).
 */
async function observeEtcd(
  cfg: Config,
  ips: readonly string[],
): Promise<{ observation: Observation | null; error: string | null }> {
  const deadline = TOPOLOGY.observationDeadlineMs;
  const members = await read(cfg, talosEtcdMembersArgv(ips), deadline);
  if (members.skipped)
    return { observation: null, error: "not read (--no-probe)" };
  const status = await read(cfg, talosEtcdStatusArgv(ips), deadline);
  const observedAt = Date.now();

  const transportErrors: string[] = [];
  if (members.code !== 0)
    transportErrors.push(`etcd members: ${short(members)}`);
  if (status.code !== 0) transportErrors.push(`etcd status: ${short(status)}`);

  // A membership that could not be read is unknown, not empty, so it stays
  // null: `evaluation.onIndeterminate: unsafe` makes every predicate refuse.
  const membership =
    members.code === 0
      ? membershipAddresses(parseEtcdMembers(members.stdout))
      : null;

  return {
    observation: {
      expected: ips,
      membership,
      statuses: status.code === 0 ? parseEtcdStatus(status.stdout) : [],
      declared: [],
      transportErrors,
      observedAt,
    },
    error: null,
  };
}

/** The same observation with `declared` set to this step's target. */
function declaring(observation: Observation, target: string): Observation {
  return { ...observation, declared: [target] };
}

function etcdCell(state: ClusterState, ip: string): string {
  if (!state.etcd) return "?";
  const m = state.etcd.statuses.find((x) => x.node === ip);
  if (!m) {
    // A membership that was not read is unknown, not empty: an address is only
    // unrepresented against a membership somebody actually saw.
    if (state.etcd.membership === null) return "?";
    return state.etcd.membership.includes(ip) ? "absent" : "unrepresented";
  }
  const flags = [`idx ${m.raftIndex}`];
  if (m.leader !== "" && m.leader === m.member) flags.push("leader");
  if (m.errors) flags.push(`ERRORS ${m.errors}`);
  return flags.join(" ");
}

function printStateTable(cfg: Config, state: ClusterState): void {
  const rows = state.nodes.map((n) => [
    n.spec.name,
    String(n.spec.vmid),
    n.spec.ip,
    n.disk ? n.disk.datastore : `? (${n.diskError ?? "unknown"})`,
    n.disk?.sizeGiB != null ? `${n.disk.sizeGiB.toFixed(0)}G` : "?",
    n.vmError ? `? (${n.vmError})` : n.vm,
    etcdCell(state, n.spec.ip),
    state.vipHolders === null
      ? "?"
      : state.vipHolders.includes(n.spec.ip)
        ? "yes"
        : "no",
    n.disk === null
      ? "?"
      : needsMigration(n.disk, cfg.targetDatastore)
        ? "needs migrating"
        : "done",
  ]);
  console.log(
    formatTable(
      ["NODE", "VMID", "IP", "DATASTORE", "SIZE", "VM", "ETCD", "VIP", "STATE"],
      rows,
    ),
  );
}

function printContext(cfg: Config, state: ClusterState): void {
  const ds = state.datastore;
  log.info(
    ds
      ? `datastore ${cfg.targetDatastore}: ${ds.type}, ${ds.status}, ${ds.availGiB.toFixed(
          0,
        )} GiB free of ${ds.totalGiB.toFixed(0)} GiB`
      : `datastore ${cfg.targetDatastore}: ${
          state.datastoreError ?? "not found"
        }`,
  );
  log.info(
    state.rootUsePct === null
      ? `Proxmox root filesystem: ${state.rootError ?? "unknown"}`
      : `Proxmox root filesystem ${state.rootUsePct}% used (limit ${cfg.maxRootUse}%)`,
  );
  const etcd = etcdGate("preflight", state.etcd, state.etcdError);
  const line = `${etcd.name}: ${etcd.detail}`;
  if (etcd.ok === true) log.ok(line);
  else log.warn(line);
  log.info(
    state.vipHolders === null
      ? `VIP ${cfg.vip}: ${state.vipError ?? "unknown"}`
      : state.vipHolders.length === 0
        ? `VIP ${cfg.vip}: held by no node`
        : `VIP ${cfg.vip}: held by ${state.vipHolders.join(", ")}`,
  );
  log.info(
    state.readyz === null
      ? `/readyz: ${state.readyzError ?? "unknown"}`
      : state.readyz
        ? `/readyz: ok (context ${cfg.context})`
        : `/readyz: NOT ok (context ${cfg.context})`,
  );
}

// ----------------------------------------------------------------------------
// status
// ----------------------------------------------------------------------------

async function cmdStatus(cfg: Config): Promise<number> {
  if (cfg.dryRun) {
    log.dry("status is read-only; the commands below are the ones it runs");
  }
  const state = await gather(cfg);
  console.log("");
  printStateTable(cfg, state);
  console.log("");
  printContext(cfg, state);

  const selected = new Set(cfg.nodes.map((n) => n.name));
  const pending = state.nodes.filter(
    (n) =>
      selected.has(n.spec.name) && needsMigration(n.disk, cfg.targetDatastore),
  );
  const unknown = state.nodes.filter(
    (n) => selected.has(n.spec.name) && n.disk === null,
  );
  if (unknown.length > 0) {
    log.warn(
      `could not read the ${cfg.disk} datastore of ${unknown
        .map((n) => n.spec.name)
        .join(", ")}`,
    );
  }
  if (pending.length === 0 && unknown.length === 0) {
    log.ok(
      `nothing to migrate: every selected control-plane ${cfg.disk} is already on ${cfg.targetDatastore}`,
    );
  } else if (pending.length > 0) {
    log.info(
      `still to migrate (in this order): ${pending
        .map(
          (n) => `${n.spec.name} (VM ${n.spec.vmid}, on ${n.disk?.datastore})`,
        )
        .join(", ")}`,
    );
    log.info(`next: task cp:migrate -- --dry-run, then --yes (${RUNBOOK})`);
  }
  return 0;
}

// ----------------------------------------------------------------------------
// migrate
// ----------------------------------------------------------------------------

function preflightGates(
  cfg: Config,
  state: ClusterState,
  pending: NodeState[],
  snapshotTaken: boolean,
): Gate[] {
  const biggestGiB = Math.max(0, ...pending.map((n) => n.disk?.sizeGiB ?? 0));
  const ds = state.datastore;
  const gates: Gate[] = [
    topologyGate(cfg.allNodes.length),
    {
      // Unknown (pvesm not read) stays unknown; a read that did not list the
      // datastore is a hard failure — runbook step 1 has not been done.
      name: `datastore ${cfg.targetDatastore} exists`,
      ok: ds ? ds.status === "active" : state.datastoreKnown ? false : null,
      detail: ds
        ? `${ds.type}, status ${ds.status}`
        : (state.datastoreError ?? "unknown"),
    },
    {
      name: `${cfg.targetDatastore} has room for the largest disk`,
      ok: ds ? ds.availGiB >= biggestGiB : state.datastoreKnown ? false : null,
      detail: ds
        ? `${ds.availGiB.toFixed(0)} GiB free, largest disk ${biggestGiB.toFixed(
            0,
          )} GiB`
        : (state.datastoreError ?? "unknown"),
    },
    {
      name: `Proxmox root filesystem below ${cfg.maxRootUse}%`,
      ok: state.rootUsePct === null ? null : state.rootUsePct < cfg.maxRootUse,
      detail:
        state.rootUsePct === null
          ? (state.rootError ?? "unknown")
          : `${state.rootUsePct}% used (a full root breaks every Proxmox operation; ` +
            `see "Host housekeeping" in the runbook)`,
    },
    // `evaluation.points`: this is the entry gate of the `fresh` run shape, and
    // its predicate is the contract's, not one chosen here.
    etcdGate("preflight", state.etcd, state.etcdError),
    {
      name: "/readyz ok",
      ok: state.readyz,
      detail:
        state.readyz === null
          ? (state.readyzError ?? "unknown")
          : state.readyz
            ? `context ${cfg.context}`
            : "the API server is not ready",
    },
    {
      name: `VIP ${cfg.vip} held by a node`,
      ok: state.vipHolders === null ? null : state.vipHolders.length === 1,
      detail:
        state.vipHolders === null
          ? (state.vipError ?? "unknown")
          : state.vipHolders.length === 0
            ? "no node holds the VIP"
            : state.vipHolders.join(", "),
    },
    {
      name: "etcd snapshot taken in this run",
      ok: cfg.skipSnapshot ? true : snapshotTaken,
      detail: cfg.skipSnapshot
        ? "--skip-snapshot: you are responsible for an off-cluster backup"
        : !snapshotTaken
          ? "no snapshot"
          : cfg.dryRun
            ? `would be written under ${cfg.snapshotDir} and checked for a non-zero size`
            : `under ${cfg.snapshotDir}`,
    },
  ];
  return gates;
}

function printGates(cfg: Config, title: string, gates: Gate[]): void {
  log.info(title);
  for (const g of gates) {
    const mark = g.ok === true ? "PASS" : g.ok === false ? "FAIL" : "UNKNOWN";
    const line = `  [${mark}] ${g.name}: ${g.detail}`;
    if (g.ok === true) log.ok(line);
    else if (g.ok === false) log.error(line);
    else if (cfg.dryRun) log.dry(line);
    else log.warn(line);
  }
}

/** Takes the etcd snapshot the runbook asks for, off-cluster, before node 1. */
async function takeSnapshot(
  cfg: Config,
  state: ClusterState,
): Promise<string | null> {
  const healthy =
    cfg.allNodes.find((n) =>
      state.etcd?.statuses.some((m) => m.node === n.ip && m.errors === ""),
    ) ?? cfg.allNodes[0];
  const path = resolve(snapshotPath(cfg.snapshotDir, new Date()));
  if (!cfg.dryRun) {
    await mkdir(cfg.snapshotDir, { recursive: true });
  } else {
    log.dry(`mkdir -p ${cfg.snapshotDir}`);
  }
  const res = await mutate(
    cfg,
    "snapshot",
    talosEtcdSnapshotArgv(healthy.ip, path),
  );
  if (res === null) return null; // dry run
  if (res.code !== 0) {
    throw new Error(`etcd snapshot failed (exit ${res.code}): ${short(res)}`);
  }
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    size = 0;
  }
  if (size === 0) {
    throw new Error(
      `etcd snapshot ${path} is missing or zero bytes; refusing to migrate`,
    );
  }
  log.ok(`etcd snapshot ${path} (${(size / 1048576).toFixed(1)} MiB)`);
  return path;
}

/** Polls `qm status` until the VM is stopped, or the timeout expires. */
async function waitForStopped(cfg: Config, node: NodeSpec): Promise<boolean> {
  const deadline = Date.now() + cfg.shutdownTimeoutMs;
  while (Date.now() < deadline) {
    const res = await read(cfg, qmStatusArgv(cfg.ssh, node.vmid));
    if (!res.skipped && res.code === 0) {
      const st = parseQmStatus(res.stdout);
      log.info(`${node.name}: VM ${node.vmid} is ${st}`);
      if (st === "stopped") return true;
    } else if (!res.skipped) {
      log.warn(`${node.name}: qm status failed: ${short(res)}`);
    }
    await delay(cfg.pollIntervalMs);
  }
  return false;
}

/**
 * The contract's `before-destructive-step`, immediately before this node is
 * stopped, with the node declared as the target.
 *
 * A fresh read, never the preflight one: the observation bound exists because
 * a reading gathered minutes ago is not "immediately before" anything. The
 * predicate is `survivable`, not `whole` — the contract's mapping, and the
 * reason it can be re-evaluated on a cluster that is mid-procedure.
 */
async function revalidateBeforeStopping(
  cfg: Config,
  node: NodeSpec,
): Promise<Gate> {
  const { observation, error } = await observeEtcd(
    cfg,
    cfg.allNodes.map((n) => n.ip),
  );
  return etcdGate(
    "before-destructive-step",
    observation === null ? null : declaring(observation, node.ip),
    error ?? undefined,
  );
}

/** The post gates for one node, evaluated once. */
function postGates(
  cfg: Config,
  node: NodeSpec,
  state: ClusterState,
  talosOk: boolean,
): Gate[] {
  const disk = state.nodes.find((n) => n.spec.name === node.name)?.disk ?? null;
  return [
    {
      name: `${node.name} Talos API answers`,
      ok: talosOk,
      detail: talosOk ? `talosctl -n ${node.ip} version` : "no answer yet",
    },
    {
      name: `${node.name} ${cfg.disk} on ${cfg.targetDatastore}`,
      ok: disk === null ? null : disk.datastore === cfg.targetDatastore,
      detail: disk ? disk.raw : "qm config not read",
    },
    // `evaluation.points`: the exit gate of both run shapes. Success means the
    // cluster is whole again, not that a kubelet reported Ready.
    etcdGate("completion", state.etcd, state.etcdError),
    {
      name: "/readyz ok",
      ok: state.readyz,
      detail: state.readyz === null ? (state.readyzError ?? "unknown") : "",
    },
    {
      name: `${node.name} Ready in kubectl get nodes`,
      ok:
        state.kubeNodes === null ? null : isNodeReady(state.kubeNodes, node.ip),
      detail:
        state.kubeNodes === null
          ? "kubectl get nodes not read"
          : (() => {
              const row = findKubeNode(state.kubeNodes, node.ip);
              return row
                ? `${row.name} ${row.status}`
                : `no node with internal IP ${node.ip}`;
            })(),
    },
    {
      name: `VIP ${cfg.vip} held by exactly one node`,
      ok: state.vipHolders === null ? null : state.vipHolders.length === 1,
      detail:
        state.vipHolders === null
          ? (state.vipError ?? "unknown")
          : state.vipHolders.join(", ") || "nobody",
    },
  ];
}

/** Polls the post gates until they all pass or --settle-timeout expires. */
async function waitForSettled(
  cfg: Config,
  node: NodeSpec,
): Promise<{ ok: boolean; gates: Gate[] }> {
  const deadline = Date.now() + cfg.settleTimeoutMs;
  let gates: Gate[] = [];
  let attempt = 0;
  while (true) {
    attempt++;
    const version = await read(cfg, talosVersionArgv(node.ip));
    const talosOk = version.skipped ? false : version.code === 0;
    const state = await gather(cfg);
    gates = postGates(cfg, node, state, talosOk);
    if (failingGates(gates, false).length === 0) return { ok: true, gates };
    if (Date.now() >= deadline) return { ok: false, gates };
    log.info(
      `${node.name}: not settled yet (attempt ${attempt}); retrying in ${formatDuration(
        cfg.pollIntervalMs,
      )}, up to ${formatDuration(cfg.settleTimeoutMs)}`,
    );
    await delay(cfg.pollIntervalMs);
  }
}

function printFailure(
  cfg: Config,
  node: NodeSpec,
  phase: string,
  detail: string,
): void {
  log.error(`${node.name} (VM ${node.vmid}): ${phase} — ${detail}`);
  log.error("STOPPING. No other node will be touched.");
  console.log("");
  console.log(`Where the cluster is now:
  - ${node.name} is the only node this run was changing; the other control
    planes were not touched and still hold quorum if they were healthy.
  - Check the VM:      ssh ${cfg.ssh.user}@${cfg.ssh.host} 'qm status ${node.vmid}; qm config ${node.vmid} | grep ${cfg.disk}'
  - Check etcd:        talosctl -n ${cfg.allNodes
    .map((n) => n.ip)
    .join(",")} etcd members     # the membership: who etcd expects
                       talosctl -n ${cfg.allNodes
                         .map((n) => n.ip)
                         .join(",")} etcd status      # who answered
  - Check the VIP:     talosctl -n ${cfg.allNodes
    .map((n) => n.ip)
    .join(",")} get addresses | rg ${cfg.vip}/
  - Check the API:     kubectl --context ${cfg.context} get --raw '/readyz?verbose' | tail -3
  - A half-moved disk: 'qm config ${node.vmid}' still points at the source
    datastore unless move-disk completed; Proxmox does not leave it in between.
  Recover this node before touching the next one:
  ${RUNBOOK} -> "Rollback" (and "etcd quorum recovery" in
  docs/runbooks/talos-upgrade.md if the node will not boot).`);
  console.log("");
}

async function cmdMigrate(cfg: Config): Promise<number> {
  const startedAt = Date.now();
  if (!cfg.yes && !cfg.dryRun) {
    log.error(
      "migrate changes production: pass --dry-run to see the plan, then --yes to run it",
    );
    log.info(`read ${RUNBOOK} first; agents never run this (ADR-009)`);
    return 2;
  }
  if (cfg.dryRun) {
    log.dry(
      cfg.noProbe
        ? "dry run with --no-probe: nothing at all is executed, the plan below is static"
        : "dry run: read-only commands (qm config/status, pvesm, df, talosctl, kubectl) DO run; " +
            "every mutating command is printed, never executed",
    );
  }
  log.info(
    `plan: ${cfg.nodes
      .map((n) => n.name)
      .join(" -> ")} | ${cfg.disk} ${cfg.sourceDatastore} -> ` +
      `${cfg.targetDatastore} | bwlimit ${cfg.bwlimit} KiB/s | ssh ${cfg.ssh.user}@${cfg.ssh.host} | context ${cfg.context}`,
  );

  const state = await gather(cfg);
  console.log("");
  printStateTable(cfg, state);
  console.log("");
  printContext(cfg, state);

  const selected = new Set(cfg.nodes.map((n) => n.name));
  const pending = state.nodes.filter(
    (n) =>
      selected.has(n.spec.name) &&
      (cfg.dryRun && n.disk === null
        ? true // unknown in a dry run: still show the plan for it
        : needsMigration(n.disk, cfg.targetDatastore)),
  );
  const skipped = state.nodes.filter(
    (n) => selected.has(n.spec.name) && !pending.includes(n),
  );
  for (const n of skipped) {
    log.ok(
      `${n.spec.name}: already on ${n.disk?.datastore ?? "?"} — nothing to do`,
    );
  }
  if (pending.length === 0) {
    log.ok("every selected control plane is already on the target datastore");
    return 0;
  }

  // Snapshot first, before any node is touched (runbook "Before you start").
  let snapshotTaken = false;
  if (cfg.skipSnapshot) {
    log.warn(
      "--skip-snapshot: no etcd snapshot will be taken by this run; make sure you have one",
    );
  } else {
    try {
      const path = await takeSnapshot(cfg, state);
      // takeSnapshot returns null in a dry run (it printed the command and ran
      // nothing); a real run has already thrown if the file was missing or 0 B.
      snapshotTaken = cfg.dryRun || path !== null;
      if (cfg.dryRun) {
        log.dry("would verify the snapshot exists and is larger than 0 bytes");
      }
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      log.error("STOPPING before any node was touched.");
      return 1;
    }
  }

  const gates = preflightGates(cfg, state, pending, snapshotTaken);
  printGates(cfg, "preflight gates:", gates);
  const failed = failingGates(gates, cfg.dryRun);
  if (failed.length > 0) {
    log.error(
      `preflight failed: ${failed
        .map((g) => g.name)
        .join("; ")} — nothing was touched`,
    );
    log.info(`fix these first; see ${RUNBOOK}`);
    return 1;
  }
  if (cfg.dryRun) {
    const unknown = gates.filter((g) => g.ok === null);
    if (unknown.length > 0) {
      log.dry(
        `${unknown.length} gate(s) could not be evaluated here; a real run aborts on those`,
      );
    }
  }

  const moved: string[] = [];
  // ONE node at a time: a plain sequential loop, never Promise.all. The
  // mutate() funnel asserts the same property at runtime for move-disk.
  for (const node of pending) {
    const spec = node.spec;
    console.log("");
    log.info(
      `=== ${spec.name} (VM ${spec.vmid}, ${spec.ip}): ${
        node.disk?.datastore ?? "?"
      } -> ${cfg.targetDatastore} ===`,
    );
    if (state.vipHolders?.includes(spec.ip)) {
      log.info(
        `${spec.name} currently holds the VIP ${cfg.vip}; it will move to another ` +
          "control plane when the VM stops. That is expected, not an error.",
      );
    }

    // 0. revalidate. `evaluation.revalidateBeforeDestructiveStep`: the preflight
    // reading is from before the first node was touched, and a check at the
    // start of a multi-step procedure is stale by the time the third node is
    // stopped. This is the contract's `before-destructive-step`, with this node
    // declared as the target it is about to take away.
    const revalidation = await revalidateBeforeStopping(cfg, spec);
    printGates(cfg, `${spec.name}: before-destructive-step:`, [revalidation]);
    if (failingGates([revalidation], cfg.dryRun).length > 0) {
      printFailure(
        cfg,
        spec,
        "the before-destructive-step gate refused",
        revalidation.detail,
      );
      return 1;
    }

    // 1. shutdown
    const shutdown = await mutate(
      cfg,
      "shutdown",
      qmShutdownArgv(cfg.ssh, spec.vmid),
    );
    if (shutdown && shutdown.code !== 0) {
      printFailure(cfg, spec, "qm shutdown failed", short(shutdown));
      return 1;
    }
    if (cfg.dryRun) {
      log.dry(
        `would poll: ${qmStatusArgv(cfg.ssh, spec.vmid).join(" ")} every ${formatDuration(
          cfg.pollIntervalMs,
        )} until "stopped", up to ${formatDuration(cfg.shutdownTimeoutMs)}`,
      );
    } else if (!(await waitForStopped(cfg, spec))) {
      if (cfg.forceStop) {
        log.warn(
          `${spec.name} did not stop within ${formatDuration(
            cfg.shutdownTimeoutMs,
          )}; --force-stop was passed, issuing qm stop`,
        );
        const stop = await mutate(cfg, "stop", qmStopArgv(cfg.ssh, spec.vmid));
        if (stop && stop.code !== 0) {
          printFailure(cfg, spec, "qm stop failed", short(stop));
          return 1;
        }
        if (!(await waitForStopped(cfg, spec))) {
          printFailure(
            cfg,
            spec,
            "the VM is still not stopped after qm stop",
            "",
          );
          return 1;
        }
      } else {
        printFailure(
          cfg,
          spec,
          `the VM did not stop within ${formatDuration(cfg.shutdownTimeoutMs)}`,
          "not forcing it off: pass --force-stop only if you are sure a hard stop is safe",
        );
        return 1;
      }
    }

    // 2. move-disk (streamed: the copy prints progress)
    const move = await mutate(
      cfg,
      "move-disk",
      qmMoveDiskArgv(
        cfg.ssh,
        spec.vmid,
        cfg.disk,
        cfg.targetDatastore,
        cfg.bwlimit,
      ),
      true,
    );
    if (move && move.code !== 0) {
      printFailure(
        cfg,
        spec,
        `qm move-disk failed (exit ${move.code})`,
        "the VM is stopped and the disk may still be on the source datastore",
      );
      return 1;
    }

    // 3. start
    const start = await mutate(cfg, "start", qmStartArgv(cfg.ssh, spec.vmid));
    if (start && start.code !== 0) {
      printFailure(
        cfg,
        spec,
        `qm start failed (exit ${start.code})`,
        short(start),
      );
      return 1;
    }

    // 4. post gates
    if (cfg.dryRun) {
      log.dry(
        `would poll every ${formatDuration(cfg.pollIntervalMs)} for up to ${formatDuration(
          cfg.settleTimeoutMs,
        )}: ${talosVersionArgv(spec.ip).join(" ")}; ${talosEtcdMembersArgv(
          cfg.allNodes.map((n) => n.ip),
        ).join(" ")}; ${talosEtcdStatusArgv(cfg.allNodes.map((n) => n.ip)).join(
          " ",
        )}; ${kubectlReadyzArgv(cfg.context).join(" ")}; ${kubectlNodesArgv(
          cfg.context,
        ).join(
          " ",
        )}; ${talosAddressesArgv(cfg.allNodes.map((n) => n.ip)).join(" ")}; ${qmConfigArgv(
          cfg.ssh,
          spec.vmid,
        ).join(" ")}`,
      );
    } else {
      const settled = await waitForSettled(cfg, spec);
      printGates(cfg, `${spec.name} post gates:`, settled.gates);
      if (!settled.ok) {
        printFailure(
          cfg,
          spec,
          `the cluster did not settle within ${formatDuration(
            cfg.settleTimeoutMs,
          )}`,
          failingGates(settled.gates, false)
            .map((g) => g.name)
            .join("; "),
        );
        return 1;
      }
      log.ok(
        `${spec.name}: disk on ${cfg.targetDatastore}, cluster whole again`,
      );
    }
    moved.push(spec.name);

    // 5. settle wait between nodes
    const isLast = pending.indexOf(node) === pending.length - 1;
    if (!isLast && !cfg.noWait) {
      if (cfg.dryRun) {
        log.dry(
          `would wait ${formatDuration(cfg.settleWaitMs)} before the next node`,
        );
      } else {
        log.info(
          `waiting ${formatDuration(
            cfg.settleWaitMs,
          )} so etcd is demonstrably steady before the next node`,
        );
        await delay(cfg.settleWaitMs);
      }
    }
  }

  console.log("");
  const elapsed = formatDuration(
    Math.round((Date.now() - startedAt) / 1000) * 1000,
  );
  const verb = cfg.dryRun ? "would move" : "moved";
  log.info(
    `${verb}: ${moved.join(", ") || "none"} | skipped (already done): ${
      skipped.map((n) => n.spec.name).join(", ") || "none"
    } | elapsed ${elapsed}`,
  );
  if (cfg.dryRun) {
    log.dry(
      `${mutations.length} mutating command(s) were printed and NOT executed; re-run with --yes to perform them`,
    );
  }
  log.warn(
    `the etcd tuning (heartbeat-interval/election-timeout/listen-metrics-urls) is NOT part of ` +
      `this script: apply it separately with terragrunt, one node per apply — ${RUNBOOK} step 3`,
  );
  log.info(`then: task cp:migrate:status and the Verify section of ${RUNBOOK}`);
  return 0;
}

// ----------------------------------------------------------------------------
// verify
// ----------------------------------------------------------------------------

async function prometheusEtcdUp(url: string): Promise<string> {
  const target = new URL("/api/v1/query", url);
  target.searchParams.set("query", 'up{job="kube-etcd"}');
  const res = await fetch(target, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Prometheus returned HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { result?: { value?: [number, string] }[] };
  } | null;
  const values: string[] = (body?.data?.result ?? []).map(
    (r: { value?: [number, string] }) => r.value?.[1] ?? "?",
  );
  return values.join(", ") || "no series";
}

async function cmdVerify(cfg: Config): Promise<number> {
  if (cfg.dryRun) {
    log.dry("verify is read-only; the commands below are the ones it runs");
  }
  const state = await gather(cfg);
  console.log("");
  printStateTable(cfg, state);
  console.log("");
  printContext(cfg, state);

  const gates: Gate[] = [
    ...cfg.nodes.map((spec): Gate => {
      const disk =
        state.nodes.find((n) => n.spec.name === spec.name)?.disk ?? null;
      return {
        name: `${spec.name} ${cfg.disk} on ${cfg.targetDatastore}`,
        ok: disk === null ? null : disk.datastore === cfg.targetDatastore,
        detail: disk ? disk.raw : "qm config not read",
      };
    }),
    topologyGate(cfg.allNodes.length),
    etcdGate("completion", state.etcd, state.etcdError),
    {
      name: "/readyz ok",
      ok: state.readyz,
      detail: state.readyz === null ? (state.readyzError ?? "unknown") : "",
    },
    {
      name: `VIP ${cfg.vip} held by exactly one node`,
      ok: state.vipHolders === null ? null : state.vipHolders.length === 1,
      detail:
        state.vipHolders === null
          ? (state.vipError ?? "unknown")
          : state.vipHolders.join(", ") || "nobody",
    },
  ];
  printGates(cfg, "verify:", gates);

  if (cfg.prometheusUrl) {
    try {
      const values = await prometheusEtcdUp(cfg.prometheusUrl);
      log.info(`up{job="kube-etcd"} = ${values} (want three 1s)`);
    } catch (err) {
      log.warn(
        `could not query Prometheus at ${cfg.prometheusUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    log.info(
      `kube-etcd scrape (best effort, not checked here): pass --prometheus-url, or port-forward\n` +
        `      kubectl --context ${cfg.context} -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9091:9090\n` +
        `      curl -s 'http://127.0.0.1:9091/api/v1/query?query=up{job="kube-etcd"}' | jq '.data.result[].value[1]'   # three 1s`,
    );
  }
  log.warn(
    `the etcd tuning is applied separately via terragrunt (${RUNBOOK} step 3); ` +
      "a migrated disk alone does not set heartbeat-interval/election-timeout",
  );

  const failed = failingGates(gates, cfg.dryRun);
  if (failed.length > 0) {
    log.error(`not verified: ${failed.map((g) => g.name).join("; ")}`);
    return 1;
  }
  log.ok(
    `every selected control-plane ${cfg.disk} is on ${cfg.targetDatastore}, etcd is healthy, ` +
      `the API is ready and the VIP is held`,
  );
  return 0;
}

// ----------------------------------------------------------------------------
// help / main
// ----------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    `cp-storage-migrate.ts — move the control-plane VM system disks from ${DEFAULT_SOURCE_DATASTORE} to
${DEFAULT_TARGET_DATASTORE}, one node at a time (${RUNBOOK})

Usage:
  scripts/cp-storage-migrate.ts status  [--only cp-1,cp-3] [--proxmox-host <ip>] [--context ${DEFAULT_CONTEXT}]
  scripts/cp-storage-migrate.ts migrate --yes | --dry-run
                                        [--only cp-2] [--bwlimit ${DEFAULT_BWLIMIT}] [--shutdown-timeout ${DEFAULT_SHUTDOWN_TIMEOUT}]
                                        [--settle-timeout ${DEFAULT_SETTLE_TIMEOUT}] [--settle-wait ${DEFAULT_SETTLE_WAIT}] [--no-wait]
                                        [--snapshot-dir ${DEFAULT_SNAPSHOT_DIR}] [--skip-snapshot] [--force-stop]
  scripts/cp-storage-migrate.ts verify  [--prometheus-url http://127.0.0.1:9091]

Subcommands:
  status   Read-only: per node the datastore of ${DEFAULT_DISK}, disk size, VM state, etcd member
           (RAFT INDEX, ERRORS), VIP holder, plus whether ${DEFAULT_TARGET_DATASTORE} exists and its free space.
           Says plainly which nodes still need migrating.
  migrate  Per node still on ${DEFAULT_SOURCE_DATASTORE}, in order: preflight gates -> per node, the
           before-destructive-step gate -> qm shutdown + poll until stopped -> qm move-disk
           ${DEFAULT_DISK} ${DEFAULT_TARGET_DATASTORE} --delete 1 --bwlimit -> qm start -> post gates polled until
           --settle-timeout -> --settle-wait -> next node. Any failure stops the run at once
           and points at the runbook's Rollback section.
  verify   Read-only: every disk on ${DEFAULT_TARGET_DATASTORE}, etcd healthy, /readyz ok, VIP held, and the
           kube-etcd scrape (needs --prometheus-url, else it prints the port-forward recipe).

The etcd gates come from contracts/cluster/topology.v1.yaml (ADR-035), not from constants here:
  preflight                the contract's \`${TOPOLOGY.predicateAt("preflight").id}\` predicate, over every expected member
  before-destructive-step  the contract's \`${TOPOLOGY.predicateAt("before-destructive-step").id}\` predicate, re-read immediately before each
                           shutdown with that node declared as the target
  completion               the contract's \`${TOPOLOGY.predicateAt("completion").id}\` predicate, after the node rejoins
The member set is etcd's own membership (talosctl etcd members), compared against the ${CP_KEY_LABEL}
count; the quorum, the tolerated unavailability and the RAFT INDEX tolerance are the contract's.
This script never removes an etcd member, so it has no \`resume\` entry point.

Preflight gates (all must pass; the run aborts otherwise):
  the control-plane count is one the contract permits (${TOPOLOGY.permittedCounts.join(", ")});
  target datastore present and active, with room for the largest disk;
  Proxmox root filesystem below --max-root-use (${DEFAULT_MAX_ROOT_USE}%);
  etcd is ${TOPOLOGY.predicateAt("preflight").id}: ${TOPOLOGY.predicateAt("preflight").conditions.join(", ")};
  kubectl get --raw /readyz returns ok; the VIP is held by exactly one node;
  an etcd snapshot was taken in this run (unless --skip-snapshot).

Flags:
  --yes                 required for migrate; without it the run is refused
  --dry-run             print every mutating ssh/talosctl/kubectl command in order and run none of
                        them. Read-only commands still run so the plan reflects the real state;
                        add --no-probe to run nothing at all.
  --only <a,b>          restrict to these nodes (default all, in --nodes order)
  --nodes <spec>        name=vmid=ip list, e.g. cp-1=101=192.0.2.11,cp-2=102=192.0.2.12
  --proxmox-host <ip>   no default             --ssh-user <user>  default ${DEFAULT_SSH_USER}
  --context <name>      default ${DEFAULT_CONTEXT}    --vip <ip>         no default
  --disk <dev>          default ${DEFAULT_DISK}          --bwlimit <KiB/s>  default ${DEFAULT_BWLIMIT}
  --target-datastore    default ${DEFAULT_TARGET_DATASTORE}    --source-datastore default ${DEFAULT_SOURCE_DATASTORE}
  --shutdown-timeout    default ${DEFAULT_SHUTDOWN_TIMEOUT}            --settle-timeout   default ${DEFAULT_SETTLE_TIMEOUT}
  --settle-wait         default ${DEFAULT_SETTLE_WAIT} (--no-wait to skip)  --poll-interval    default ${DEFAULT_POLL_INTERVAL}
  --max-root-use <pct>  default ${DEFAULT_MAX_ROOT_USE}            --raft-tolerance   default ${DEFAULT_RAFT_TOLERANCE}
  --snapshot-dir <dir>  default ${DEFAULT_SNAPSHOT_DIR} (--skip-snapshot to skip)
  --force-stop          after --shutdown-timeout, hard-stop the VM (off by default)
  --prometheus-url      verify only: query up{job="kube-etcd"} directly

Defaults (from ${HOMELAB_ENV_FILE}, gitignored; no address is hardcoded here):
  --nodes        every ${CP_KEY_LABEL} key present (${CP_FIRST_KEY} required, one per
                 control plane, ordinals may skip; as cp-<n>=<100+n>)
  --vip          ${VIP_KEY}          --proxmox-host  ${PROXMOX_HOST_KEY}
  A flag always wins over the file; a value neither flag nor file supplies is a
  usage error, never a guess. HOMELAB_ENV_FILE overrides the path of that file.

Every mutating command goes through one function that cannot run while --dry-run is set, and only
one qm move-disk is ever in flight (a sequential loop plus a runtime assertion). The etcd extraArgs
tuning is NOT done here: apply it with terragrunt, one node per apply (${RUNBOOK} step 3).
Agents run status, verify and --dry-run only (ADR-009).
Exit codes: 0 success, 1 a gate or command failed, 2 usage error.`,
  );
}

/**
 * The addresses from the gitignored environment file. A missing or unreadable
 * file yields no defaults at all: buildConfig then names the flag and the key
 * instead of falling back to an address baked into this repository.
 */
async function readEnvDefaults(): Promise<ArgEnv> {
  const path = process.env.HOMELAB_ENV_FILE ?? HOMELAB_ENV_FILE;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  return {
    nodes: nodesFromEnvFile(text) ?? undefined,
    proxmoxHost: envFileValue(text, PROXMOX_HOST_KEY) ?? undefined,
    vip: envFileValue(text, VIP_KEY) ?? undefined,
  };
}

async function main(): Promise<number> {
  let cfg: Config;
  try {
    const args = parseArgs(process.argv.slice(2), await readEnvDefaults());
    if (args.command === "help") {
      printHelp();
      return 0;
    }
    cfg = buildConfig(args);
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(err.message);
      console.error("run with --help for usage");
      return 2;
    }
    throw err;
  }
  try {
    switch (cfg.command) {
      case "status":
        return await cmdStatus(cfg);
      case "migrate":
        return await cmdMigrate(cfg);
      case "verify":
        return await cmdVerify(cfg);
      default:
        printHelp();
        return 0;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      log.error(err.message);
      return 2;
    }
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
