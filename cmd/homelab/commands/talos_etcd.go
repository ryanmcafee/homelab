package commands

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/etcd"
	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/topology"
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

// controlPlaneIPs returns the configured control-plane addresses in ordinal
// order, as the resolver already derived them.
//
// The key-name rule (`^CP([0-9]+)_IP$`) is applied once, in
// config.DeriveControlPlane, and this reads the result. Re-applying the
// pattern here would be a second statement of the contract's
// controlPlane.countKeyPattern, which is the duplication ADR-035 exists to
// end — and the one that can disagree with the first.
func controlPlaneIPs(rc *config.ResolvedConfig) []string {
	// A fork may point several keys at one address (the localdev set points
	// all three at 127.0.0.1); querying the same endpoint three times would
	// invent members that do not exist.
	seen := map[string]bool{}
	out := make([]string, 0, len(rc.ControlPlane))
	for _, m := range rc.ControlPlane {
		ip := strings.TrimSpace(m.Address)
		if ip == "" || seen[ip] {
			continue
		}
		seen[ip] = true
		out = append(out, ip)
	}
	return out
}

// containsIP reports whether ip is one of the configured addresses. It is how
// a control plane whose etcd member is already gone is told apart from a
// worker, which never had one.
func containsIP(ips []string, ip string) bool {
	for _, v := range ips {
		if v == ip {
			return true
		}
	}
	return false
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
	// ExpectWhole is the member count etcd must return to before the
	// recreate may report success, or 0 when this node is not an etcd node
	// at all and the wait does not apply.
	//
	// It is deliberately not derived from Removed. A resumed run finds the
	// member already gone (Removed=false) but is still rebuilding a control
	// plane that has to rejoin, and skipping the recovery wait there would
	// report success over a cluster left at N-1 — the exact "green on top,
	// degraded underneath" outcome this command exists to prevent.
	ExpectWhole int
}

// etcdPhaseOptions carries the inputs of the etcd phase.
type etcdPhaseOptions struct {
	nodeIP        string
	cpIPs         []string
	snapshotDir   string
	raftTolerance int64
	contract      *topology.Contract
}

// observeEtcd takes one bounded reading of the cluster: etcd's own membership
// and the status of every member in it.
//
// The whole read runs under the contract's observationDeadline, not a
// per-call timeout. `revalidateBeforeDestructiveStep` is meaningless without
// one: a consumer with no deadline can block on a wedged endpoint and then
// act on a reading older than the fault it was meant to catch.
//
// A dial, deadline or apid failure is recorded as a transport error rather
// than folded into the member set. etcd healthy behind a wedged apid and etcd
// down are different faults; both refuse, but the operator is told which.
func observeEtcd(ctx context.Context, opts etcdPhaseOptions, endpoints, declared []string) (string, etcd.Observation, string, error) {
	octx, cancel := context.WithTimeout(ctx, opts.contract.ObservationDeadline)
	defer cancel()

	startedAt := time.Now()
	via, members, rawMembers, err := etcdMemberList(octx, endpoints)
	if err != nil {
		return "", etcd.Observation{}, "", err
	}

	obs := etcd.Observation{
		Expected:   opts.cpIPs,
		Members:    members,
		Declared:   declared,
		ObservedAt: startedAt,
	}

	// A declared target is not queried for status. The operation has already
	// said that member is going away, and it is usually going away *because*
	// it is broken; asking it to converge first would make the gate
	// unsatisfiable on the exact runs it exists for. It is absent and
	// declared, which is what `absences-are-declared` is for. At preflight
	// and completion nothing is declared, so every member is queried.
	query := etcd.MemberIPs(members)
	for _, ip := range declared {
		query = exceptIP(query, ip)
	}

	var rawStatus string
	if len(query) > 0 {
		statuses, raw, serr := etcdStatusOf(octx, via, query)
		if serr != nil {
			// Not an early return: a transport failure is part of the
			// observation, and the predicate refuses on it by name.
			obs.TransportErrors = append(obs.TransportErrors, serr.Error())
		}
		obs.Statuses = statuses
		rawStatus = raw
	}

	return via, obs, strings.TrimRight(rawMembers, "\n") + "\n" + strings.TrimRight(rawStatus, "\n"), nil
}

// evaluateAt applies whichever predicate the contract assigns to the given
// evaluation point. The mapping is never inlined here: `whole` at
// before-destructive-step aborts every procedure and `survivable` at
// preflight consents to starting on a cluster that was already a member
// short, and both are one line away.
//
// Fail-closed: a status table that does not parse yields no rows, so every
// member reads as absent and the predicate refuses. "Could not tell" is not
// "safe to proceed".
func evaluateAt(point topology.PointID, opts etcdPhaseOptions, obs etcd.Observation) error {
	p, err := opts.contract.PredicateAt(point)
	if err != nil {
		return err
	}

	v := etcd.Evaluate(opts.contract, p, obs)
	if !v.OK {
		return fmt.Errorf("etcd does not satisfy `%s` at %s: %s", p.ID, point, v.Reason())
	}
	logger.OK(fmt.Sprintf("etcd satisfies `%s` at %s: %d member(s) answered and converged%s",
		p.ID, point, v.Answered, declaredAbsenceSuffix(v)))
	return nil
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
	via, obs, raw, err := observeEtcd(ctx, opts, endpoints, []string{opts.nodeIP})
	if err != nil {
		// A dry run has to be readable from a fork with no cluster to
		// talk to yet, so an unreachable etcd only downgrades the plan
		// there. A real run stops: destroying a control-plane VM whose
		// etcd membership you could not even read is the bug.
		return nil, dryRunTolerable(err)
	}
	members := obs.Members
	logger.Info(fmt.Sprintf("etcd as observed via %s:\n%s", via, raw))

	entry, err := etcd.SelectEntry(opts.contract, members, opts.nodeIP)
	if err != nil {
		return nil, dryRunTolerable(err)
	}
	target := entry.Target
	if !entry.TargetIsMember {
		// Nothing to remove either way — that is the idempotency guarantee.
		// But the two reasons a node is not a member need different
		// endings, so they are told apart here rather than conflated.
		out := &etcdRemoval{Removed: false, ClusterSize: len(members), SurvivorIPs: etcd.MemberIPs(members)}
		if !containsIP(opts.cpIPs, opts.nodeIP) {
			logger.OK(fmt.Sprintf("%s is not an etcd member and not a control plane — a worker, nothing to remove",
				opts.nodeIP))
			return out, nil
		}

		// A control plane that is not in the member list: an earlier run
		// removed it and died before the node rejoined. This is the resume
		// path, and it is gated, not merely narrated. Finding nothing to
		// remove says only that this run will not remove a second member; it
		// says nothing about whether the cluster can survive the VM being
		// destroyed in the next step. If the crashed run left {cp-1, cp-3}
		// and cp-3 has since died, etcd has no quorum, the replacement's
		// member add cannot commit, and going ahead destroys a VM to spend
		// the rejoin timeout failing.
		out.ExpectWhole = len(opts.cpIPs)
		if verr := evaluateAt(entry.Point, opts, obs); verr != nil {
			return nil, dryRunTolerable(verr)
		}
		logger.Warn(fmt.Sprintf(
			"%s is a control plane but not an etcd member: an earlier run removed it and did not finish. "+
				"Resuming — no second member will be removed, and this run waits for etcd to return to %d members.",
			opts.nodeIP, out.ExpectWhole))
		return out, nil
	}

	logger.Info(fmt.Sprintf("%s is etcd member %s (%s) of a %d-member cluster",
		opts.nodeIP, target.ID, target.Hostname, len(members)))

	survivors := etcd.Without(members, target.ID)
	survivorIPs := etcd.MemberIPs(survivors)
	expected := len(opts.cpIPs)

	// The `survivable` gate, evaluated before anything destructive. The
	// outgoing member is the declared target, so it is allowed to be absent
	// or broken — that is usually why it is being replaced — but every
	// *other* expected member must have answered and converged, and the
	// arithmetic is measured against the configured control-plane size, not
	// against the live member list.
	if verr := evaluateAt(topology.BeforeDestructiveStep, opts, obs); verr != nil {
		if derr := dryRunTolerable(verr); derr != nil {
			return nil, fmt.Errorf("refusing to remove etcd member %s (%s): %w", target.ID, opts.nodeIP, derr)
		}
	}

	healthyRemaining := etcd.HealthyCount(obs.Statuses, opts.raftTolerance)

	// The post-removal projection, on top of the current-state gate above:
	// the survivors have to reach quorum at the size the cluster will be
	// once this member is gone. `expected` and not len(members) — see
	// etcd.CheckRemoval.
	if safety := etcd.CheckRemoval(opts.contract, expected, healthyRemaining); !safety.OK {
		return nil, fmt.Errorf("refusing to remove etcd member %s (%s): %s", target.ID, opts.nodeIP, safety.Reason)
	}
	logger.OK(fmt.Sprintf("Quorum check passed: %d healthy survivor(s) of a %d-member control plane, quorum of %d after removal",
		healthyRemaining, expected, opts.contract.Quorum(expected-1)))

	// A cluster that ends up below quorum-plus-one has no fault tolerance
	// left while the replacement boots, and the operator should know that
	// before the confirmation prompt, not after.
	if opts.contract.MaxUnavailable(expected-1) == 0 {
		logger.Warn(fmt.Sprintf(
			"While %s is rebuilt etcd runs on %d member(s) with no spare: a single further failure loses quorum "+
				"until it rejoins. The snapshot taken below is the only way back from that.",
			opts.nodeIP, expected-1))
	}

	removal := &etcdRemoval{
		Removed:     true,
		MemberID:    target.ID,
		ClusterSize: len(members),
		SurvivorIPs: survivorIPs,
		ExpectWhole: expected,
	}

	// Unconditional: the snapshot is a precondition of the removal, not an
	// option on it. There is no flag to turn this off.
	path, serr := takeEtcdSnapshot(ctx, via, opts.snapshotDir)
	if serr != nil {
		return nil, fmt.Errorf("refusing to remove etcd member %s: %w", target.ID, serr)
	}
	removal.SnapshotPath = path

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

	// Revalidate immediately before the taint rather than trusting the gate
	// from the top of this function. The removal is a raft write and a leader
	// election can follow it, so the cluster the terragrunt step is about to
	// act on is not the one that was measured a minute ago. The VM is still
	// intact at this point, so a refusal here is recoverable: the member is
	// out, the snapshot is on disk, and re-running resumes.
	if !utils.DryRun {
		// A fresh observation, not the one from the top of this function:
		// the removal is a raft write and a leader election can follow it,
		// so the cluster the terragrunt step is about to act on is not the
		// one that was measured a minute ago. The contract's
		// maxObservationAge would reject reusing that reading anyway.
		_, afterObs, _, merr := observeEtcd(ctx, opts, survivorIPs, []string{opts.nodeIP})
		if merr != nil {
			return nil, fmt.Errorf("etcd member %s was removed but the member list is no longer readable, "+
				"so the cluster cannot be confirmed survivable before the VM is destroyed: %w\n"+
				"The snapshot at %s is the way back — see docs/runbooks/talos-upgrade.md (Scenario 4)",
				target.ID, merr, removal.SnapshotPath)
		}
		if verr := evaluateAt(topology.BeforeDestructiveStep, opts, afterObs); verr != nil {
			return nil, fmt.Errorf("etcd member %s was removed, but the cluster is no longer safe to destroy a VM in: %w\n"+
				"Nothing else has been touched. The snapshot at %s is the way back — "+
				"see docs/runbooks/talos-upgrade.md (Scenario 4)", target.ID, verr, removal.SnapshotPath)
		}
	}

	return removal, nil
}

// preflightEtcd runs the contract's entry gate before anything is cordoned,
// drained, removed or destroyed.
//
// It applies only when the node being recreated is a configured control
// plane. Recreating a worker does not touch etcd, and gating it on the
// control plane's health would block worker replacement on a cluster that is
// already short a control plane — refusing the repair because of the fault.
//
// WHICH gate depends on what the cluster is. `evaluation.points` is a map
// from point to predicate, not a pipeline, and the contract defines `resume`
// as "a re-run that finds the declared target already absent from the member
// list". So a run is at exactly one entry point:
//
//   - the target is still a member: a fresh procedure, gated on `preflight`
//     (`whole`). A control plane that is already short a member is sent to
//     the runbook rather than into an automated replacement.
//   - the target is already gone: a re-run after a crash, gated on `resume`
//     (`survivable`). Evaluating `whole` here instead would refuse every
//     legitimate recovery — the cluster is short a member by construction at
//     that point, which is precisely the state `resumeSemantics` describes
//     resuming from. A guard an operator must bypass to finish a recovery is
//     not a guard.
func preflightEtcd(ctx context.Context, opts etcdPhaseOptions) error {
	if !containsIP(opts.cpIPs, opts.nodeIP) {
		logger.Info(fmt.Sprintf("%s is not a configured control plane, so the etcd preflight does not apply", opts.nodeIP))
		return nil
	}

	degraded, cerr := opts.contract.CheckCount(len(opts.cpIPs))
	if cerr != nil {
		return dryRunTolerable(cerr)
	}
	if degraded {
		logger.Warn(fmt.Sprintf(
			"%d configured control plane(s): contracts/cluster/topology.v1.yaml calls this a degraded topology with "+
				"no fault tolerance at all. %s", len(opts.cpIPs), opts.contract.RemovalOfLastMemberGuidance))
	}

	endpoints := append(exceptIP(opts.cpIPs, opts.nodeIP), opts.nodeIP)
	via, obs, raw, err := observeEtcd(ctx, opts, endpoints, nil)
	if err != nil {
		return dryRunTolerable(err)
	}
	logger.Info(fmt.Sprintf("etcd as observed via %s:\n%s", via, raw))

	entry, err := etcd.SelectEntry(opts.contract, obs.Members, opts.nodeIP)
	if err != nil {
		return dryRunTolerable(err)
	}
	if !entry.TargetIsMember {
		obs.Declared = []string{opts.nodeIP}
		logger.Warn(fmt.Sprintf(
			"%s is a configured control plane with no etcd member: an earlier run removed it and did not finish. "+
				"Entering at `%s` rather than `%s`.", opts.nodeIP, topology.Resume, topology.Preflight))
	}

	return dryRunTolerable(evaluateAt(entry.Point, opts, obs))
}

// declaredAbsenceSuffix names the absence the predicate accepted, so a passing
// gate still says out loud which member is missing and why that was allowed.
func declaredAbsenceSuffix(v etcd.Verdict) string {
	if len(v.Absent) == 0 {
		return ""
	}
	return fmt.Sprintf(" (%s absent, and declared as this operation's target)", strings.Join(v.Absent, ", "))
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

// waitEtcdHealthy polls until the cluster satisfies `whole`: every configured
// control plane is a member, answered, and converged. Called after the
// replacement node boots, so the recreate only reports success once etcd is
// actually whole again.
//
// `whole` and not a member count, because a count is satisfiable by the wrong
// cluster. #39's failure shape is a member at the right address under the
// wrong id; a cluster carrying both the stale member and the rebuilt one has
// the expected number of members and is broken. `whole` measures the members
// against the configured addresses, so the stale one is an unexpected member
// and the wait keeps failing until it is gone.
func waitEtcdHealthy(ctx context.Context, opts etcdPhaseOptions, endpoints []string, timeout time.Duration) (string, error) {
	expected := len(opts.cpIPs)
	if utils.DryRun {
		logger.Warn(fmt.Sprintf("Would poll etcd until all %d configured control plane(s) are whole", expected))
		return "", nil
	}
	p, err := opts.contract.PredicateAt(topology.Completion)
	if err != nil {
		return "", err
	}

	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		// No declared targets at completion: by this point nothing is
		// allowed to be missing, which is the whole difference between this
		// gate and the one before the destructive step.
		_, obs, raw, oerr := observeEtcd(ctx, opts, endpoints, nil)
		if oerr != nil {
			last = oerr.Error()
		} else if v := etcd.Evaluate(opts.contract, p, obs); v.OK {
			return raw, nil
		} else {
			last = v.Reason()
		}
		logger.Info(fmt.Sprintf("etcd not %s yet: %s", p.ID, last))
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(etcdPollInterval):
		}
	}
	return "", fmt.Errorf("etcd did not satisfy `%s` on all %d configured control plane(s) within %s (last: %s)",
		p.ID, expected, timeout, last)
}
