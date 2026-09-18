# Talos and Kubernetes upgrade plan — v1.12.2 / v1.32.0 → v1.14.0 / v1.37.0

Date: 2026-09-17. Owner runs every apply; agents only prepare and verify (ADR-009).
Procedure per step: `docs/runbooks/talos-upgrade.md`, Procedure 1.

## Where we are

| | Running (tfstate, `env.hcl`) | Registry wanted (Renovate) |
|---|---|---|
| Talos | v1.12.2 | v1.14.0 |
| Kubernetes | v1.32.0 | v1.37.0 |
| talosctl (mise) | 1.13.8 | — |
| kubectl (mise) | 1.36.3 | — |

`configuration/versions.yaml` was moved back to the running versions in the PR that added the
`versions/pins` level-0 check, so the README badges and Renovate now describe reality. Each step
below bumps `versions.yaml` **and** `env.hcl` together; the check fails on any PR where they
differ.

## Rules that decide the order

- Kubernetes: one minor at a time (control plane first, then kubelets); the kubelet may lag the
  API server by up to three minors but never lead it.
- Talos: one minor at a time; each Talos minor supports a range of Kubernetes minors — check
  the [support matrix](https://www.talos.dev/latest/introduction/support-matrix/) for the exact
  pair before every step and prefer the newest Kubernetes patch the Talos release lists.
- etcd is on `cp-storage` with heartbeat 250 / election 2500 (PR #288); keep `task
  apiserver:probe` running during control-plane steps, a VIP move is expected, an API outage
  is not.
- Before each step: `task verify:prod` green, `talosctl -n <CP1_IP> etcd members` shows three
  healthy members, `task cp:migrate:status` shows every control plane on `cp-storage`, etcd
  snapshot taken (runbook step 2).

## Steps

Each step is one PR (Renovate's or a hand one) that bumps both files, then one apply session.

| # | Talos | Kubernetes | Notes |
|---|---|---|---|
| 1 | v1.12.2 → v1.13.x | v1.32.0 → v1.33.x | Talos first (`talos-image*` → `talos-cluster` → nodes one at a time), then Kubernetes through `talos-cluster-config` (`talosctl upgrade-k8s`) |
| 2 | v1.13.x → v1.14.0 | v1.33.x → v1.34.x | same |
| 3 | v1.14.0 | v1.34.x → v1.35.x | Kubernetes only, if the matrix allows on 1.14 |
| 4 | v1.14.0 | v1.35.x → v1.36.x | Kubernetes only |
| 5 | v1.14.0 | v1.36.x → v1.37.0 | Kubernetes only; matches Kind (`images.kind-node v1.36.1` → bump to v1.37 in the same PR so the loop tests the same minor) |

If the matrix says v1.14.0 does not carry v1.37, stop at the newest supported minor and let
Renovate propose the rest when a newer Talos lands.

Per step, in order:

1. PR: `configuration/versions.yaml` `tools.talos` / `tools.kubernetes`, `terragrunt/environments/homelab/env.hcl` `talos_version` / `kubernetes_version`, `mise.toml` `talosctl` / `kubectl` to the same minor. Level 0 must be green (`versions/pins`).
2. `task tf:apply:component COMPONENT=talos-image`, `talos-image-gpu-intel` (and `talos-image-gpu` to keep the NVIDIA schematic buildable).
3. `task tf:plan:component COMPONENT=talos-cluster` → expect only the installer image/version to change; apply; the module rolls nodes one at a time (control planes first). Between nodes: `talosctl -n <node> health --wait-timeout 15m`, `kubectl get nodes`.
4. Kubernetes: `task tf:apply:component COMPONENT=talos-cluster-config` (or `talosctl -n <CP1_IP> upgrade-k8s --to <version>`), then `kubectl get nodes -o wide` shows the new kubelet on every node.
5. `task verify:prod`, `task apiserver:probe`, `task prod:status`; Kind loop green on the PR.

## Rollback

Talos keeps the previous install on the other partition: `talosctl -n <node> rollback`. For
Kubernetes, `talosctl upgrade-k8s --to <previous>` is supported one minor back. etcd snapshot
restore is the last resort (runbook, "Recovery").

## Done when

`env.hcl`, `versions.yaml`, `mise.toml` and `kubectl get nodes` all say v1.14.0 / v1.37.0,
the `versions/pins` check is green, and the README badges (rendered from `versions.yaml`)
show the same.
