#!/usr/bin/env bash
# Behavioural test for the etcd handling in `homelab talos recreate`
# (ryanmcafee/homelab#39).
#
# It drives the real binary against a fake three-node control plane built from
# the shims in ./fake, inside a throwaway project root seeded from
# configuration/environments/homelab.yaml.example. Nothing here touches a real
# cluster, so it runs anywhere `go` and `bash` do — including on a fresh fork
# that has no cluster yet.
#
# What it proves, one case per acceptance criterion on #39:
#
#   A  a control plane is replaced at the SAME static IP, single command,
#      zero manual intervention, ending at three healthy members
#   B  re-running after a crash between "member removed" and "node rejoined"
#      does NOT remove a second member
#   C  it refuses, non-zero, when a survivor is unreachable
#   D  it refuses, non-zero, when a survivor is raft-lagging beyond tolerance
#   E  a worker is recreated without touching etcd at all
#   F  a failed graceful `etcd leave` falls back to `remove-member`
#   G  no snapshot means no removal
#   H  it refuses to remove a SECOND member after an earlier run crashed
#   I  a resume refuses when a survivor has died since the crash
#
# Usage: tests/talos-recreate/run.sh   (or: task test:talos-recreate)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/homelab-talos-recreate.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

export FAKE_STATE="$SANDBOX/cluster"
export PATH="$HERE/fake:$PATH"

BIN="$SANDBOX/homelab"
SNAPSHOTS="$SANDBOX/snapshots"

pass=0
fail=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mPASS\033[0m %s\n' "$*"; pass=$((pass + 1)); }
bad()  { printf '   \033[31mFAIL\033[0m %s\n' "$*"; fail=$((fail + 1)); }

# assert_contains <label> <file> <needle>
assert_contains() {
  if grep -qF -- "$3" "$2"; then ok "$1"; else
    bad "$1 — expected to find: $3"
    sed 's/^/        | /' "$2" | tail -25
  fi
}

# assert_absent <label> <file> <needle>
assert_absent() {
  if grep -qF -- "$3" "$2"; then
    bad "$1 — did not expect: $3"
  else ok "$1"; fi
}

# assert_eq <label> <got> <want>
assert_eq() {
  if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1 — got '$2', want '$3'"; fi
}

# A throwaway project root: the binary walks up to a Taskfile.yml and reads
# configuration/ from there, so the real repo's configuration/homelab.yaml
# (gitignored, and absent on a fresh fork) is never needed.
setup_project() {
  mkdir -p "$SANDBOX/project/terragrunt/environments/homelab/talos-cluster"
  touch "$SANDBOX/project/Taskfile.yml" "$SANDBOX/project/.env.op"
  cp -r "$REPO/configuration/schema" "$REPO/configuration/versions.yaml" "$SANDBOX/project/configuration/" 2>/dev/null \
    || { mkdir -p "$SANDBOX/project/configuration"; cp -r "$REPO/configuration/schema" "$REPO/configuration/versions.yaml" "$SANDBOX/project/configuration/"; }
  mkdir -p "$SANDBOX/project/configuration/environments"
  cp "$REPO/configuration/environments/defaults.yaml" "$SANDBOX/project/configuration/environments/"
  # The documented first step of a fork: copy the example and fill it in.
  cp "$REPO/configuration/environments/homelab.yaml.example" \
     "$SANDBOX/project/configuration/environments/homelab.yaml"
}

# A fresh three-control-plane cluster plus one worker, matching the IPs in
# homelab.yaml.example.
reset_cluster() {
  rm -rf "$FAKE_STATE"; mkdir -p "$FAKE_STATE"
  {
    printf 'a1b2c3d4e5f60001\ttalos-aa1-bb1\t192.168.1.11\n'
    printf 'a1b2c3d4e5f60002\ttalos-cc2-dd2\t192.168.1.12\n'
    printf 'a1b2c3d4e5f60003\ttalos-ee3-ff3\t192.168.1.13\n'
  } > "$FAKE_STATE/members"
  {
    printf 'talos-aa1-bb1\t192.168.1.11\n'
    printf 'talos-cc2-dd2\t192.168.1.12\n'
    printf 'talos-ee3-ff3\t192.168.1.13\n'
    printf 'talos-w01-w01\t192.168.1.21\n'
  } > "$FAKE_STATE/k8snodes"
  {
    printf 'cp-1\t192.168.1.11\ncp-2\t192.168.1.12\ncp-3\t192.168.1.13\nworker-1\t192.168.1.21\n'
  } > "$FAKE_STATE/vmips"
  {
    echo 'proxmox_virtual_environment_vm.controlplane["cp-1"]'
    echo 'proxmox_virtual_environment_vm.controlplane["cp-2"]'
    echo 'proxmox_virtual_environment_vm.controlplane["cp-3"]'
    echo 'proxmox_virtual_environment_vm.worker["worker-1"]'
  } > "$FAKE_STATE/tfstate"
  for ip in 192.168.1.11 192.168.1.12 192.168.1.13; do touch "$FAKE_STATE/is_cp_$ip"; done
  echo 9182740 > "$FAKE_STATE/raft_index"
}

members_count() { grep -c . "$FAKE_STATE/members" || true; }
has_member()    { awk -F'\t' -v ip="$1" '$3==ip' "$FAKE_STATE/members" | grep -qc . ; }

# recreate <logfile> <extra args...>; echoes the exit code.
recreate() {
  local log="$1"; shift
  local rc=0
  ( cd "$SANDBOX/project" && "$BIN" -y talos recreate --etcd-snapshot-dir="$SNAPSHOTS" "$@" ) > "$log" 2>&1 || rc=$?
  echo "$rc"
}

# GO lets a caller point at a specific toolchain (mise, a sandbox that does
# not export PATH into nested shells, CI with several Go versions installed).
GO="${GO:-go}"
echo "Building homelab from $REPO with $GO"
( cd "$REPO" && "$GO" build -o "$BIN" ./cmd/homelab )
setup_project

# ---------------------------------------------------------------------------
say "A  replace a control plane at the SAME static IP"
reset_cluster
rc=$(recreate "$SANDBOX/a.log" --node=cp-2)
assert_eq   "exits 0" "$rc" "0"
assert_contains "removes the member before the taint" "$SANDBOX/a.log" \
  "192.168.1.12 is etcd member a1b2c3d4e5f60002"
assert_contains "verifies the removal took effect" "$SANDBOX/a.log" \
  "removed and confirmed absent from the member list"
assert_contains "takes a verified snapshot first" "$SANDBOX/a.log" "etcd snapshot verified"
assert_contains "waits for etcd to be whole again"  "$SANDBOX/a.log" "etcd is whole again"
assert_eq   "back to three members" "$(members_count)" "3"
if has_member 192.168.1.12; then ok "the rebuilt node rejoined at the same IP"
else bad "the rebuilt node did not rejoin at 192.168.1.12"; fi
# The order matters more than anything else here: a removal after the taint
# is the bug, not the fix.
if [[ $(grep -n "confirmed absent" "$SANDBOX/a.log" | head -1 | cut -d: -f1) \
      -lt $(grep -n "terragrunt apply -replace" "$SANDBOX/a.log" | head -1 | cut -d: -f1) ]]; then
  ok "the removal happens BEFORE the terragrunt taint"
else
  bad "the removal did not happen before the terragrunt taint"
fi

# ---------------------------------------------------------------------------
say "B  idempotent: a crashed run already removed the member"
reset_cluster
awk -F'\t' '$3 != "192.168.1.12"' "$FAKE_STATE/members" > "$FAKE_STATE/m" && mv "$FAKE_STATE/m" "$FAKE_STATE/members"
rc=$(recreate "$SANDBOX/b.log" --node=cp-2)
assert_eq   "exits 0" "$rc" "0"
assert_contains "notices the member is already gone" "$SANDBOX/b.log" \
  "is a control plane but not an etcd member"
assert_absent   "does not remove a second member"    "$SANDBOX/b.log" "confirmed absent from the member list"
assert_eq   "cp-1 and cp-3 survived" \
  "$(awk -F'\t' '$3=="192.168.1.11" || $3=="192.168.1.13"' "$FAKE_STATE/members" | grep -c .)" "2"
# A resume is not a worker. Finding the member already gone must not switch the
# recovery wait off: reporting success over a cluster still at 2 of 3 is how a
# degraded control plane gets signed off as healthy.
assert_contains "resumes instead of treating the node as a non-member" "$SANDBOX/b.log" \
  "an earlier run removed it and did not finish"
assert_contains "still waits for etcd to be whole again" "$SANDBOX/b.log" "etcd is whole again"
assert_eq   "resume ends at three members" "$(members_count)" "3"
if has_member 192.168.1.12; then ok "the resumed node rejoined at the same IP"
else bad "the resumed node did not rejoin at 192.168.1.12"; fi

# ---------------------------------------------------------------------------
say "C  refuses when a surviving member is unreachable"
reset_cluster
touch "$FAKE_STATE/down_192.168.1.13"
rc=$(recreate "$SANDBOX/c.log" --node=cp-2)
assert_eq   "exits non-zero" "$rc" "1"
assert_contains "names the reason" "$SANDBOX/c.log" "refusing to remove etcd member"
assert_contains "names the quorum arithmetic" "$SANDBOX/c.log" "a quorum of 2 is required"
assert_contains "names the member at fault, not just \"unhealthy\"" "$SANDBOX/c.log" \
  "192.168.1.13 are absent and are not a declared target"
assert_eq   "nothing was removed" "$(members_count)" "3"
assert_absent "nothing was applied" "$SANDBOX/c.log" "Apply complete"

# ---------------------------------------------------------------------------
say "D  refuses when a surviving member is raft-lagging"
reset_cluster
echo 5000 > "$FAKE_STATE/lag_192.168.1.13"
rc=$(recreate "$SANDBOX/d.log" --node=cp-2)
assert_eq   "exits non-zero" "$rc" "1"
assert_contains "names the lag and the tolerance" "$SANDBOX/d.log" "behind 9182740 (tolerance 10)"
assert_eq   "nothing was removed" "$(members_count)" "3"

# ---------------------------------------------------------------------------
say "E  a worker is recreated without touching etcd"
reset_cluster
rc=$(recreate "$SANDBOX/e.log" --node=worker-1)
assert_eq   "exits 0" "$rc" "0"
assert_contains "recognises a non-member" "$SANDBOX/e.log" "192.168.1.21 is not an etcd member"
assert_absent   "takes no snapshot"       "$SANDBOX/e.log" "etcd snapshot verified"
assert_eq   "all three members untouched" "$(members_count)" "3"

# ---------------------------------------------------------------------------
say "F  falls back to remove-member when the graceful leave fails"
reset_cluster
touch "$FAKE_STATE/leave_fails"
rc=$(recreate "$SANDBOX/f.log" --node=cp-2)
assert_eq   "exits 0" "$rc" "0"
assert_contains "falls back"       "$SANDBOX/f.log" "falling back to remove-member"
assert_contains "still verifies"   "$SANDBOX/f.log" "confirmed absent from the member list"
assert_eq   "back to three members" "$(members_count)" "3"

# ---------------------------------------------------------------------------
say "G  a snapshot that cannot be written blocks the removal"
reset_cluster
rc=$(recreate "$SANDBOX/g.log" --node=cp-2 --etcd-snapshot-dir=/proc/sys/no-such-place)
assert_eq   "exits non-zero" "$rc" "1"
assert_contains "refuses without a backup" "$SANDBOX/g.log" "refusing to remove etcd member"
assert_eq   "nothing was removed" "$(members_count)" "3"

# ---------------------------------------------------------------------------
# The defect from the review of PR #364. A crashed recreate of cp-2 left
# membership at {cp-1, cp-3}; the operator now recreates cp-3. Sized off the
# LIVE member list the arithmetic consents: two live members meet Quorum(2)=2,
# and after the removal the one survivor meets Quorum(1)=1 — so the guard would
# take a three-node control plane down to a single etcd member, as the
# aftermath of this very command. Sized off the configured CP<n>_IP count it
# refuses. A member that is *down* was always caught, because it stays in the
# list and fails to answer; a member already *removed* is not there to be
# missed, which is why this case needs its own gate.
say "H  refuses to remove a second member after an earlier run crashed"
reset_cluster
awk -F'\t' '$3 != "192.168.1.12"' "$FAKE_STATE/members" > "$FAKE_STATE/m" && mv "$FAKE_STATE/m" "$FAKE_STATE/members"
rc=$(recreate "$SANDBOX/h.log" --node=cp-3)
assert_eq   "exits non-zero" "$rc" "1"
assert_contains "names the member an earlier run left out" "$SANDBOX/h.log" \
  "192.168.1.12 are absent and are not a declared target"
assert_contains "measures against the configured control-plane count" "$SANDBOX/h.log" \
  "of 3 expected member(s) answered"
assert_eq   "no second member was removed" "$(members_count)" "2"
assert_absent "nothing was applied" "$SANDBOX/h.log" "Apply complete"
assert_absent "no snapshot was taken, because nothing was destroyed" "$SANDBOX/h.log" "etcd snapshot verified"

# ---------------------------------------------------------------------------
# The resume path must evaluate a predicate, not just report that there is
# nothing to remove. A crashed run left {cp-1, cp-3} and cp-3 has since died:
# etcd has no quorum, the replacement's member add cannot commit, and going
# ahead would destroy the VM only to spend the rejoin timeout failing. The
# refusal has to come before the taint.
say "I  a resume refuses when a survivor has died since the crash"
reset_cluster
awk -F'\t' '$3 != "192.168.1.12"' "$FAKE_STATE/members" > "$FAKE_STATE/m" && mv "$FAKE_STATE/m" "$FAKE_STATE/members"
touch "$FAKE_STATE/down_192.168.1.13"
rc=$(recreate "$SANDBOX/i.log" --node=cp-2)
assert_eq   "exits non-zero" "$rc" "1"
assert_contains "evaluates the predicate at the resume point" "$SANDBOX/i.log" \
  'does not satisfy `survivable` at resume'
assert_contains "names the dead survivor" "$SANDBOX/i.log" "192.168.1.13"
assert_absent "does not destroy the VM first" "$SANDBOX/i.log" "Apply complete"
assert_eq   "membership untouched" "$(members_count)" "2"

# ---------------------------------------------------------------------------
printf '\n%s\n' "-----------------------------------------------"
printf 'talos recreate etcd behaviour: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
