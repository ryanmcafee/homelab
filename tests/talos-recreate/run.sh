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
assert_contains "notices the member is already gone" "$SANDBOX/b.log" "is not an etcd member"
assert_absent   "does not remove a second member"    "$SANDBOX/b.log" "confirmed absent from the member list"
assert_eq   "cp-1 and cp-3 survived" \
  "$(awk -F'\t' '$3=="192.168.1.11" || $3=="192.168.1.13"' "$FAKE_STATE/members" | grep -c .)" "2"

# ---------------------------------------------------------------------------
say "C  refuses when a surviving member is unreachable"
reset_cluster
touch "$FAKE_STATE/down_192.168.1.13"
rc=$(recreate "$SANDBOX/c.log" --node=cp-2)
assert_eq   "exits non-zero" "$rc" "1"
assert_contains "names the reason" "$SANDBOX/c.log" "refusing to remove etcd member"
assert_contains "names the quorum arithmetic" "$SANDBOX/c.log" "needing a quorum of 2"
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
printf '\n%s\n' "-----------------------------------------------"
printf 'talos recreate etcd behaviour: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
