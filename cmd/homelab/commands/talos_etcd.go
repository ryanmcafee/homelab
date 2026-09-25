package commands

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/etcd"
	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
)

const (
	// defaultEtcdSnapshotDir matches DEFAULT_SNAPSHOT_DIR in
	// scripts/cp-storage-migrate.ts so both tools write their snapshots to
	// the same gitignored place.
	defaultEtcdSnapshotDir = "./etcd-snapshots"

	// etcdRemovalTimeout is how long to wait for the removed member to
	// disappear from every surviving member's view. Removal is a raft
	// write, so it lands in seconds; this is generous.
	etcdRemovalTimeout = 2 * time.Minute

	// etcdRejoinTimeout is how long to wait after the VM comes back for
	// etcd to return to its full member count and pass the health gate.
	// A fresh member has to be caught up by the leader, which on a busy
	// cluster takes longer than the node takes to boot.
	etcdRejoinTimeout = 15 * time.Minute

	etcdPollInterval = 10 * time.Second

	// talosctlTimeout bounds a single read-only talosctl call so an
	// unreachable node fails fast instead of hanging the recreate.
	talosctlTimeout = 60 * time.Second
)

// cpIPKeyRe matches the resolved-config keys holding control-plane
// addresses. The count is discovered rather than assumed: a fork running one
// or five control planes is handled by the same code as this repo's three.
var cpIPKeyRe = regexp.MustCompile(`^CP(\d+)_IP$`)

// controlPlaneIPs returns the configured control-plane IPs ordered by their
// index (CP1, CP2, ... CP10), skipping keys that resolved to an empty value.
// Pure — unit tested.
func controlPlaneIPs(values map[string]config.ConfigValue) []string {
	type entry struct {
		n  int
		ip string
	}
	var entries []entry
	for key, v := range values {
		m := cpIPKeyRe.FindStringSubmatch(key)
		if m == nil || strings.TrimSpace(v.Value) == "" {
			continue
		}
		n, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		entries = append(entries, entry{n: n, ip: strings.TrimSpace(v.Value)})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].n < entries[j].n })

	// A fork may point several keys at one address (the localdev set points
	// all three at 127.0.0.1); querying the same endpoint three times would
	// invent members that do not exist.
	seen := map[string]bool{}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if seen[e.ip] {
			continue
		}
		seen[e.ip] = true
		out = append(out, e.ip)
	}
	return out
}

// exceptIP returns ips without the given address.
func exceptIP(ips []string, ip string) []string {
	out := make([]string, 0, len(ips))
	for _, v := range ips {
		if v != ip {
			out = append(out, v)
		}
	}
	return out
}

// talosctlCapture runs a read-only talosctl command against one node and
// returns its stdout. Read-only calls run even under --dry-run: knowing the
// real member list is what makes a dry run worth reading.
func talosctlCapture(ctx context.Context, ip string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, talosctlTimeout)
	defer cancel()
	argv := append([]string{"-n", ip}, args...)
	out, err := exec.CommandContext(cctx, "talosctl", argv...).Output()
	if err != nil {
		return "", fmt.Errorf("talosctl %s: %w", strings.Join(argv, " "), stderrOf(err))
	}
	return string(out), nil
}

// etcdMemberList queries `etcd members` from the first endpoint that answers
// and returns that endpoint alongside the parsed list. Trying every endpoint
// matters: the node being replaced is frequently the one that is wedged.
func etcdMemberList(ctx context.Context, endpoints []string) (string, []etcd.Member, string, error) {
	var lastErr error
	for _, ip := range endpoints {
		raw, err := talosctlCapture(ctx, ip, "etcd", "members")
		if err != nil {
			logger.Warn(fmt.Sprintf("etcd members via %s failed: %v", ip, err))
			lastErr = err
			continue
		}
		members := etcd.ParseMembers(raw)
		if len(members) == 0 {
			lastErr = fmt.Errorf("talosctl -n %s etcd members returned no parseable rows", ip)
			logger.Warn(lastErr.Error())
			continue
		}
		return ip, members, raw, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no control-plane endpoints to query")
	}
	return "", nil, "", fmt.Errorf("could not read the etcd member list from any of %s: %w",
		strings.Join(endpoints, ", "), lastErr)
}

// etcdStatusOf queries `etcd status` for the given member IPs in one call and
// returns the parsed rows plus the raw table for the operator's log.
func etcdStatusOf(ctx context.Context, queryVia string, ips []string) ([]etcd.Status, string, error) {
	if len(ips) == 0 {
		return nil, "", fmt.Errorf("no etcd member addresses to query")
	}
	// talosctl -n takes the full list; the endpoint it dials is the first
	// one, so ask through a node we already know answers.
	cctx, cancel := context.WithTimeout(ctx, talosctlTimeout)
	defer cancel()
	argv := []string{"-n", strings.Join(ips, ","), "etcd", "status"}
	if queryVia != "" {
		argv = append([]string{"-e", queryVia}, argv...)
	}
	cmd := exec.CommandContext(cctx, "talosctl", argv...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()

	// A member that is down makes talosctl exit non-zero while still
	// printing rows for the members that did answer. Those rows are the
	// useful signal: the health gate counts them against the expected
	// member count and refuses with "2 member(s) answered, expected 3",
	// which names the problem far better than a raw talosctl error. Only
	// when nothing parsed is the exit status itself the answer.
	rows := etcd.ParseStatus(string(out))
	if err != nil {
		if len(rows) == 0 {
			return nil, "", fmt.Errorf("talosctl %s: %w", strings.Join(argv, " "), stderrOf(err))
		}
		logger.Warn(fmt.Sprintf("talosctl etcd status reported an error for some members: %s",
			strings.TrimSpace(stderr.String())))
	}
	return rows, string(out), nil
}

// dryRunTolerable downgrades an error that only exists because the cluster is
// unreachable. Under --dry-run it is logged and swallowed, so `homelab
// --dry-run talos recreate` still prints a plan on a fresh fork that has no
// cluster yet; otherwise it is returned unchanged and the recreate stops
// before anything is destroyed.
func dryRunTolerable(err error) error {
	if err == nil || !utils.DryRun {
		return err
	}
	logger.Warn(fmt.Sprintf("dry run: etcd membership could not be determined (%v). "+
		"A real run would STOP here rather than recreate a node whose etcd membership is unknown.", err))
	return nil
}

// etcdRemoval records what the etcd phase did, for the summary the operator
// reads at the end of a recreate.
type etcdRemoval struct {
	// Removed is false when the node was not an etcd member: a worker, or
	// a control plane whose member was already removed by an earlier run.
	Removed bool
	// MemberID is the id that was removed (or found already absent).
	MemberID string
	// ClusterSize is the member count before the removal.
	ClusterSize int
	// SnapshotPath is the verified snapshot taken before the removal.
	SnapshotPath string
	// SurvivorIPs are the members expected to still be serving.
	SurvivorIPs []string
}

// etcdPhaseOptions carries the inputs of the etcd phase.
type etcdPhaseOptions struct {
	nodeIP        string
	cpIPs         []string
	snapshotDir   string
	skipSnapshot  bool
	raftTolerance int64
}

// prepareEtcdForRecreate is the guard that stands between `talos recreate`
// and the terragrunt taint. It:
//
//  1. reads the live member list and decides whether this node is even an
//     etcd member — a worker is not, and neither is a control plane whose
//     member a previous crashed run already removed. Both cases return
//     Removed=false and let the recreate continue. This is the whole
//     idempotency story: re-running never removes a second member, because
//     the member it would remove is already gone.
//  2. refuses outright when removing the member would cost quorum, or when
//     the surviving members are unhealthy or raft-lagging, using the same
//     rule as scripts/cp-storage-migrate.ts.
//  3. takes and verifies an etcd snapshot, because this is the highest
//     blast-radius operation in the repo and there is no way back without
//     one.
//  4. removes the member and verifies from a survivor that it is gone.
//
// Any error returned here aborts the recreate before anything is destroyed.
func prepareEtcdForRecreate(ctx context.Context, opts etcdPhaseOptions) (*etcdRemoval, error) {
	if len(opts.cpIPs) == 0 {
		err := fmt.Errorf("no CP<n>_IP values in the resolved config: cannot tell whether %s is an etcd member, "+
			"and recreating a control plane without removing its etcd member is what this guard exists to prevent",
			opts.nodeIP)
		return nil, dryRunTolerable(err)
	}

	// Ask a control plane that is not the one going away: the outgoing node
	// may already be unresponsive, and its view is the least trustworthy.
	endpoints := append(exceptIP(opts.cpIPs, opts.nodeIP), opts.nodeIP)
	via, members, rawMembers, err := etcdMemberList(ctx, endpoints)
	if err != nil {
		// A dry run has to be readable from a fork with no cluster to
		// talk to yet, so an unreachable etcd only downgrades the plan
		// there. A real run stops: destroying a control-plane VM whose
		// etcd membership you could not even read is the bug.
		return nil, dryRunTolerable(err)
	}
	logger.Info(fmt.Sprintf("etcd member list (via %s):\n%s", via, strings.TrimRight(rawMembers, "\n")))

	target, isMember := etcd.FindMemberByIP(members, opts.nodeIP)
	if !isMember {
		logger.OK(fmt.Sprintf(
			"%s is not an etcd member — nothing to remove (a worker, or a member an earlier run already removed)",
			opts.nodeIP))
		return &etcdRemoval{Removed: false, ClusterSize: len(members), SurvivorIPs: etcd.MemberIPs(members)}, nil
	}

	logger.Info(fmt.Sprintf("%s is etcd member %s (%s) of a %d-member cluster",
		opts.nodeIP, target.ID, target.Hostname, len(members)))

	survivors := etcd.Without(members, target.ID)
	survivorIPs := etcd.MemberIPs(survivors)

	// Health of the survivors, measured against how many survivors there
	// are — the outgoing member is deliberately excluded, because it is
	// allowed to be broken. That is usually why it is being replaced.
	statuses, rawStatus, err := etcdStatusOf(ctx, via, survivorIPs)
	if err != nil {
		return nil, fmt.Errorf("refusing to remove etcd member %s: the surviving members did not report status: %w",
			target.ID, err)
	}
	logger.Info(fmt.Sprintf("etcd status of the %d surviving member(s):\n%s",
		len(survivorIPs), strings.TrimRight(rawStatus, "\n")))

	health := etcd.CheckHealth(statuses, len(survivorIPs), opts.raftTolerance)
	healthyRemaining := etcd.HealthyCount(statuses, opts.raftTolerance)

	if safety := etcd.CheckRemoval(len(members), healthyRemaining); !safety.OK {
		detail := safety.Reason
		if !health.OK {
			detail += " — " + strings.Join(health.Problems, "; ")
		}
		return nil, fmt.Errorf("refusing to remove etcd member %s (%s): %s", target.ID, opts.nodeIP, detail)
	}
	if !health.OK {
		return nil, fmt.Errorf("refusing to remove etcd member %s (%s): the surviving members are not healthy: %s",
			target.ID, opts.nodeIP, strings.Join(health.Problems, "; "))
	}
	logger.OK(fmt.Sprintf("Quorum check passed: %d healthy survivor(s), quorum of %d after removal",
		len(survivorIPs), etcd.Quorum(len(members)-1)))

	// The gate above is measured against the cluster that actually exists,
	// not against this repo's three, so a fork with a different topology is
	// not blocked. But a cluster that ends up below the expected size has
	// no fault tolerance left while the replacement boots, and the operator
	// should know that before the confirmation prompt, not after.
	if len(members)-1 < etcd.ExpectedMembers {
		logger.Warn(fmt.Sprintf(
			"After this removal etcd runs on %d member(s), below the expected %d: "+
				"a single further failure loses quorum until %s rejoins. "+
				"Consider restoring the cluster to %d members first.",
			len(members)-1, etcd.ExpectedMembers, opts.nodeIP, etcd.ExpectedMembers))
	}

	removal := &etcdRemoval{
		Removed:     true,
		MemberID:    target.ID,
		ClusterSize: len(members),
		SurvivorIPs: survivorIPs,
	}

	if opts.skipSnapshot {
		logger.Warn("--skip-etcd-snapshot: no snapshot will be taken by this run. " +
			"You are responsible for an off-cluster backup; there is no rollback path without one.")
	} else {
		path, serr := takeEtcdSnapshot(ctx, via, opts.snapshotDir)
		if serr != nil {
			return nil, fmt.Errorf("refusing to remove etcd member %s: %w", target.ID, serr)
		}
		removal.SnapshotPath = path
	}

	if !AutoAccept && !DryRun {
		msg := fmt.Sprintf("Remove etcd member %s (%s, %s) from the %d-member cluster? This is irreversible without the snapshot.",
			target.ID, target.Hostname, opts.nodeIP, len(members))
		if !utils.Confirm(msg) {
			return nil, fmt.Errorf("recreate aborted: user declined etcd member removal")
		}
	}

	if err := removeEtcdMember(ctx, opts.nodeIP, target, via); err != nil {
		return nil, err
	}

	if err := waitMemberGone(ctx, via, target.ID, etcdRemovalTimeout); err != nil {
		return nil, err
	}
	logger.OK(fmt.Sprintf("etcd member %s removed and confirmed absent from the member list", target.ID))

	return removal, nil
}

// takeEtcdSnapshot streams a snapshot off the cluster and refuses to return a
// path it could not verify: a zero-byte or missing file is not a backup.
func takeEtcdSnapshot(ctx context.Context, via, dir string) (string, error) {
	abs, err := filepath.Abs(filepath.Join(dir, etcd.SnapshotName(time.Now())))
	if err != nil {
		return "", fmt.Errorf("resolving snapshot path: %w", err)
	}

	if utils.DryRun {
		logger.Warn(fmt.Sprintf("Would run: mkdir -p %s && talosctl -n %s etcd snapshot %s", dir, via, abs))
		return abs, nil
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("creating snapshot dir %s: %w", dir, err)
	}
	logger.Info(fmt.Sprintf("Taking an etcd snapshot from %s → %s", via, abs))
	if err := streamCmd("", "", "", "talosctl", "-n", via, "etcd", "snapshot", abs); err != nil {
		return "", fmt.Errorf("etcd snapshot failed: %w", err)
	}

	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("etcd snapshot %s is missing after a successful talosctl run: %w", abs, err)
	}
	if info.Size() == 0 {
		return "", fmt.Errorf("etcd snapshot %s is zero bytes; refusing to remove a member without a usable backup", abs)
	}
	logger.OK(fmt.Sprintf("etcd snapshot verified: %s (%.1f MiB)", abs, float64(info.Size())/(1024*1024)))
	return abs, nil
}

// removeEtcdMember takes the member out of the cluster, preferring the
// graceful path. `etcd leave` is talosctl's own recommendation: it tells the
// node to leave, which also stops etcd there, so the VM about to be destroyed
// stops serving before it disappears. `remove-member` is the fallback for a
// node that cannot be reached or cannot talk to etcd — which is exactly the
// wedged-node case this command is most often run for.
func removeEtcdMember(ctx context.Context, nodeIP string, target etcd.Member, via string) error {
	logger.Info(fmt.Sprintf("Removing etcd member %s: trying the graceful path first (talosctl -n %s etcd leave)",
		target.ID, nodeIP))
	err := streamCmd("", "", "", "talosctl", "-n", nodeIP, "etcd", "leave")
	if err == nil {
		return nil
	}
	logger.Warn(fmt.Sprintf("etcd leave on %s failed (%v) — falling back to remove-member from %s", nodeIP, err, via))

	// The ID is passed through exactly as `etcd members` printed it, so the
	// representation cannot be mangled on the round trip.
	if err := streamCmd("", "", "", "talosctl", "-n", via, "etcd", "remove-member", target.ID); err != nil {
		return fmt.Errorf("both etcd leave (on %s) and etcd remove-member %s (via %s) failed: %w",
			nodeIP, target.ID, via, err)
	}
	return nil
}

// waitMemberGone polls the member list until the removed id is absent. The
// recreate must not proceed on the assumption that a command that exited 0
// took effect.
func waitMemberGone(ctx context.Context, via, id string, timeout time.Duration) error {
	if utils.DryRun {
		logger.Warn(fmt.Sprintf("Would poll talosctl -n %s etcd members until %s is gone", via, id))
		return nil
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		raw, err := talosctlCapture(ctx, via, "etcd", "members")
		if err != nil {
			lastErr = err
		} else if !etcd.HasID(etcd.ParseMembers(raw), id) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(etcdPollInterval):
		}
	}
	if lastErr != nil {
		return fmt.Errorf("etcd member %s still present (or unverifiable) after %s: %w", id, timeout, lastErr)
	}
	return fmt.Errorf("etcd member %s is still in the member list after %s; refusing to destroy the VM "+
		"while etcd still expects it — see docs/runbooks/talos-upgrade.md (Scenario 4)", id, timeout)
}

// waitEtcdHealthy polls until the cluster is back to `expected` members and
// passes the health gate. Called after the replacement node boots, so the
// recreate only reports success once etcd is actually whole again.
func waitEtcdHealthy(ctx context.Context, endpoints []string, expected int, tolerance int64, timeout time.Duration) (string, error) {
	if utils.DryRun {
		logger.Warn(fmt.Sprintf("Would poll etcd until %d healthy member(s) answer", expected))
		return "", nil
	}
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		via, members, rawMembers, err := etcdMemberList(ctx, endpoints)
		if err != nil {
			last = err.Error()
		} else if len(members) == expected {
			statuses, rawStatus, serr := etcdStatusOf(ctx, via, etcd.MemberIPs(members))
			if serr != nil {
				last = serr.Error()
			} else if h := etcd.CheckHealth(statuses, expected, tolerance); h.OK {
				return strings.TrimRight(rawMembers, "\n") + "\n\n" + strings.TrimRight(rawStatus, "\n"), nil
			} else {
				last = strings.Join(h.Problems, "; ")
			}
		} else {
			last = fmt.Sprintf("%d member(s), expected %d", len(members), expected)
		}
		logger.Info(fmt.Sprintf("etcd not whole yet: %s", last))
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(etcdPollInterval):
		}
	}
	return "", fmt.Errorf("etcd did not return to %d healthy member(s) within %s (last: %s)", expected, timeout, last)
}
