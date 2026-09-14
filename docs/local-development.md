# Local Development Guide

How to run the whole GitOps stack on a laptop with Kind (Kubernetes in Docker) and
ArgoCD, sync the working tree into it, and verify it (`task verify LEVEL=1|2`). Nothing
here touches the homelab cluster: agents may mutate only Kind (ADR-009).

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [The Kind + ArgoCD loop](#the-kind--argocd-loop)
- [Tilt Modes](#tilt-modes)
- [Development Workflow](#development-workflow)
- [Testing Strategies](#testing-strategies)
- [Debugging](#debugging)
- [CI Integration](#ci-integration)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

### Why Local Development?

**"Test before you wreck."**

- **Same charts, same ArgoCD**: every Application the homelab runs syncs in Kind too,
  through the same templates and the same health checks
- **Working tree in, verdict out**: `task localdev:sync` pushes uncommitted changes with
  `argocd app sync --local`; `task verify LEVEL=2` tells you whether every Application is
  Healthy and every e2e test passes
- **Risk-free**: break things without affecting production; CI runs the same loop on every
  pull request
- **Offline**: no VPN, no hardware, no 1Password (fakes stand in for the platform)

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Developer workstation / GitHub runner                                   │
│                                                                          │
│  Docker                                                                  │
│  ┌────────────────────────────────────────────┐  ┌────────────────────┐  │
│  │  Kind cluster "homelab-localdev"           │  │ kind-registry-*    │  │
│  │  1 control-plane + 2 workers, Cilium CNI   │◄─┤ pull-through       │  │
│  │                                            │  │ caches (docker.io, │  │
│  │  argocd/   ArgoCD (chart from versions.yaml│  │ ghcr, quay, k8s,   │  │
│  │            + health Lua from bootstrap)    │  │ lscr) -> ~/.cache  │  │
│  │     └─ gitops ─┬─ (bootstrap: not created)   │  └────────────────────┘  │
│  │                ├─ addons (cilium, traefik, │                          │
│  │                │   cert-manager, ...)      │  localhost:8080 ArgoCD   │
│  │                └─ applications (plex, *arr,│  localhost:9080/9443     │
│  │                    mosquitto, ...)         │    (Kind ports 80/443)   │
│  │  fakes: StorageClass aliases, seeded       │                          │
│  │         Secrets, OnePasswordItem CRD       │                          │
│  └────────────────────────────────────────────┘                          │
│         ▲ argocd app sync --local <working tree>                         │
│  scripts/localdev-kind.ts   scripts/localdev-argocd.ts   chainsaw        │
│  (task localdev:kind)       (task localdev:argocd|sync|  (task test:e2e) │
│                              wait|diagnose)                              │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key Differences from Production

Every difference is a capability key in `configuration/schema/platform.schema.yaml`,
overridden in `configuration/environments/localdev.yaml` (ADR-011, ADR-012); the
templates switch on the key, never on the environment name.

| Feature | Production (homelab) | Local Dev (localdev) | Key |
|---------|------------|-----------|-----|
| Platform | Proxmox VMs (Talos) | Kind (Docker) | |
| Nodes | 2 control-plane + 3 workers | 1 control-plane + 2 workers | `localdev/kind-config.yaml` |
| CNI | Cilium (Talos inline manifest, BGP) | Cilium, installed by `scripts/localdev-kind.ts`, adopted by the `cilium` Application | `CNI_PROVIDER=cilium` |
| Load balancer | Cilium LB IPAM + BGP | none; Services are NodePort | `LOAD_BALANCER_ENABLED=false` |
| DNS | external-dns (Cloudflare, UniFi) | none; e2e tests send `Host: <app>.homelab.local` | `EXTERNAL_DNS_ENABLED=false`, `DOMAIN=homelab.local` |
| Storage | democratic-csi (TrueNAS NFS/iSCSI) | local-path, plus `democratic-csi-*` StorageClass aliases from the fakes | `STORAGE_PROVIDER=local-path`, `STORAGE_CLASS_*=local-path` |
| Media libraries | NFS mounts from TrueNAS | `emptyDir` | `MEDIA_PROVIDER=ephemeral` |
| TLS | Let's Encrypt (Cloudflare DNS-01) | self-signed `letsencrypt` ClusterIssuer (same name, so every reference works) | `CERT_ISSUER=selfsigned` |
| Secrets | 1Password operator + SOPS | seeded fakes in `localdev/fakes/secrets.yaml` | `SECRETS_PROVIDER=none` |
| Sync | automated (prune + selfHeal) | manual; the working tree is pushed with `argocd app sync --local` | `ARGOCD_AUTOMATED_SYNC=false` |
| GPU | NVIDIA | none | |

---

## Prerequisites

### Required Software

Everything is pinned in `mise.toml`; run `mise install` after cloning. Docker Desktop
(or another Docker engine) is the only external prerequisite.

| Tool | Version | Role |
|------|---------|------|
| Docker Desktop | 24+ with 8 GB RAM allocated | runs the Kind nodes and the registry caches |
| kind | `configuration/versions.yaml` `tools.kind` (v0.33.0), node image `images.kind-node` | cluster |
| kubectl | mise | |
| helm | `tools.helm` (4.3.0) | Cilium and ArgoCD installs; every render |
| argocd | `tools.argocd` (v3.5.2) | `argocd app sync --local`, health fixture tests |
| chainsaw | `tools.chainsaw` (v0.2.15) | e2e tests |
| deno | mise | every script under `scripts/` |
| task | mise | task runner |
| tilt | mise (0.37.3) | optional: hot-reload wrapper around the loop |
| yq, jq | mise | version and values extraction in the scripts |

### System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8+ cores |
| RAM | 8 GB | 16+ GB |
| Disk | 20 GB free (plus the registry cache, several GB) | 50+ GB free |
| Docker | 6 GB RAM allocated | 8+ GB RAM allocated |

The full loop (every addon and application) needs the recommended tier; `task
localdev:warm` (addons only; bootstrap is not created in localdev) fits the minimum.

---

## Quick Start

```bash
task localdev:up            # Kind (Cilium, caches, fakes) -> ArgoCD -> sync every Application
task localdev:wait          # block until every Application is Healthy (prints diagnostics on failure)
task verify:text LEVEL=2    # level 0 + dry run + Application health + chainsaw e2e
task localdev:down          # delete the cluster (registry caches are kept)
```

`task localdev:ci` is the non-interactive version CI runs: kind, argocd, sync, wait, e2e.

### Verify Installation

```bash
kubectl --context kind-homelab-localdev get nodes
kubectl --context kind-homelab-localdev -n argocd get applications
```

**Expected Output**:

```
$ kubectl --context kind-homelab-localdev get nodes
NAME                             STATUS   ROLES           AGE   VERSION
homelab-localdev-control-plane   Ready    control-plane   5m    v1.36.1
homelab-localdev-worker          Ready    <none>          5m    v1.36.1
homelab-localdev-worker2         Ready    <none>          5m    v1.36.1

$ kubectl --context kind-homelab-localdev -n argocd get applications
NAME                    SYNC STATUS   HEALTH STATUS
gitops                  OutOfSync     Healthy
addons                  OutOfSync     Healthy
cilium                  OutOfSync     Healthy
traefik-internal        OutOfSync     Healthy
...
```

`OutOfSync` is expected: see [Why every Application shows OutOfSync](#why-every-application-shows-outofsync).

**ArgoCD UI**: http://localhost:8080, user `admin`, password:

```bash
task localdev:ui             # macOS: kubectl port-forward to argocd-server on localhost:8080 (keep it running)
kubectl --context kind-homelab-localdev -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d
```

On Linux the Kind port mapping (NodePort 30080 to host 8080) serves the UI directly and
`task localdev:ui` is optional. On macOS the mapping never completes a TCP handshake: see
[Host ports on macOS](#host-ports-on-macos).

---

## The Kind + ArgoCD loop

### Tasks

| Task | What it does | Script |
|------|--------------|--------|
| `task localdev:kind` | Create the cluster (`kindest/node:<images.kind-node>`, `localdev/kind-config.yaml`), start the registry caches, write `hosts.toml` into every node, install Cilium, wait for Ready nodes, apply the fakes. Idempotent. | `scripts/localdev-kind.ts up` |
| `task localdev:argocd` | `helm upgrade --install argo-cd` at `charts.argocd` from `versions.yaml` with `localdev/values/argocd-values.yaml` plus one `--set-file` per health script in `charts/bootstrap/files/health/`, apply the root Application `localdev/argocd/gitops-app.yaml`, log the `argocd` CLI in through its own `kubectl port-forward` to `argocd-server`. Idempotent. | `scripts/localdev-argocd.ts install` |
| `task localdev:sync` | Sync every Application from the working tree, tier by tier (parent wave, then own wave): git-path apps with `argocd app sync --local <path> --local-repo-root <repo>`, chart apps with a plain `argocd app sync`. A later parent's subtree (applications) is not started until every lower parent (addons) has finished creating and settling its waves, mirroring ArgoCD's own ordering in homelab where applications only starts once addons is Healthy. `-- --warm` stops after addons (the bootstrap Application is not created in localdev); `-- --only a,b` limits it; `-- --dry-run` prints the commands. Failed operations retry 3 times. A git-path app that renders nothing locally is synced plainly when `main` renders nothing either (empty app → Synced/Healthy) and skipped altogether when its path does not exist on `main` yet (`git cat-file -e origin/main:<path>`: a new chart with nothing to deploy in localdev; `wait`, `report` and `verify LEVEL=2` treat it as complete). | `scripts/localdev-argocd.ts sync` |
| `task localdev:wait` | Poll until every Application is Healthy with a Succeeded operation (default 20 min); on timeout run diagnose and exit 1. `-- --require-synced` also demands Synced (off by default, see below). | `scripts/localdev-argocd.ts wait` |
| `task localdev:diagnose` | For every Application that is not Healthy/Succeeded: conditions, operation message, every managed resource with its health (`-` when ArgoCD reports none), then per namespace (each unhealthy Application's destination plus its unhealthy resources' namespaces, `argocd` last) the recent events, describe + logs of pods not Running, a statefulsets/deployments/jobs table and `kubectl describe` of each unhealthy custom resource. | `scripts/localdev-argocd.ts diagnose` |
| `task localdev:report` | Markdown report of the loop: level-2 verdict (`-- --verify-json verify-level2.json`), a table of every Application (health, last operation, vs `main`) and one `argocd app diff` per Application that is not Synced (`-` main, `+` working tree). `-- --out <file>`, `--no-diff`, `--max-diff-bytes 0` for full diffs. Read-only; CI posts it on PRs as the `kind-preview` comment. | `scripts/localdev-argocd.ts report` |
| `task drill:restore` | kind + argocd + `sync --warm` + `test:drill`: the CloudNativePG backup/restore drill in `tests/drills/` (`.github/workflows/restore-drill.yml` runs it weekly). `task test:drill` alone on a warm cluster. | |
| `task localdev:up` | kind + argocd + sync. | |
| `task localdev:warm` | kind + argocd + `sync --warm`: operators and CRDs up, applications left for a later `task localdev:sync`. | |
| `task localdev:ci` | kind + argocd + sync + wait + `test:e2e`. What `tilt-ci.yml` runs. | |
| `task localdev:ui` | `kubectl port-forward` to `argocd-server` so the UI is on http://localhost:8080 (needed on macOS, optional on Linux). | |
| `task localdev:traefik` | `kubectl port-forward` to Traefik internal on localhost:9080 / 9443, for `curl -H 'Host: <app>.homelab.local'` from the host. | |
| `task localdev:fakes` | Re-apply `localdev/fakes/`. | `scripts/localdev-kind.ts fakes` |
| `task localdev:registry -- up\|down\|status` | Manage the pull-through caches. | `scripts/localdev-kind.ts registry` |
| `task localdev:down` | `tilt down` (if running) and delete the cluster; `-- --purge-cache` also removes the caches and their directory. | `scripts/localdev-kind.ts down` |
| `task test:e2e` | `chainsaw test --config tests/e2e/.chainsaw.yaml tests/e2e` (`-- --test-dir tests/e2e/<name>` for one). | |
| `task test:health` | Evaluate every health Lua against `tests/health/` fixtures. No cluster needed. | `scripts/health-test.ts` |
| `task verify LEVEL=1` | Level 0 + `kubectl apply --server-side --dry-run=server` of every localdev chart. | `homelab verify all --level 1` |
| `task verify LEVEL=2` | Level 1 + `argocd/<app>` health checks + `e2e/<test>` chainsaw results, one JSON summary. | `homelab verify all --level 2` |

Every script pins `--context kind-homelab-localdev` and re-logs the `argocd` CLI in with
the initial admin secret on each run, so a stray `kubectl config use-context` cannot point
the loop at production. The ArgoCD script talks to `argocd-server` through its own
`kubectl port-forward` (default `127.0.0.1:18080`, `--local-port` to change), not the
NodePort, so it works on macOS too. Each script has `--help` and `--dry-run`.

### Host ports on macOS

`localdev/kind-config.yaml` maps NodePort 30080 to host 8080 (ArgoCD) and container ports
80/443 to 9080/9443. On Linux these work. On macOS with Docker Desktop they never complete
a TCP handshake once Cilium is the CNI: Docker Desktop's port forwarder emits packets with
bad TCP checksums; kindnet let the kernel skip validation, but Cilium's BPF endpoint
delivery makes the pod validate them and drop every SYN (`TcpInCsumErrors` in the pod
namespace grows by 3 per SYN; verified with `conntrack` and `cilium monitor`). Do not debug
the cluster for this; use the port-forward tasks:

```bash
task localdev:ui        # ArgoCD UI on http://localhost:8080
task localdev:traefik   # Traefik internal on http://localhost:9080 and https://localhost:9443
```

Everything that matters (smoke hooks, e2e tests, `task verify LEVEL=2`) runs in-cluster
and is unaffected.

### Why every Application shows OutOfSync

The root Application (`localdev/argocd/gitops-app.yaml`) points at GitHub `main` because
ArgoCD needs a repository to compare against, but nothing is synced from it: `task
localdev:sync` pushes the working tree with `argocd app sync --local`. ArgoCD then
compares the live state with `main` and reports `OutOfSync` for anything that differs
(which is everything your branch changed, plus the whole tree when your branch is ahead).
That is correct and harmless.

It only works because **automated sync is off in localdev** (`ARGOCD_AUTOMATED_SYNC=false`
renders `global.automatedSync: false`, so no Application carries `syncPolicy.automated`):
an automated Application would revert the local sync to Git on its next reconciliation,
and `argocd app sync --local` refuses such Applications outright. This is why `task
localdev:wait` and `task verify LEVEL=2` judge `health` + `operationState.phase` and never
`sync.status`.

To see what a plain Git sync would do, `argocd app diff <app>` compares live state against
`main`; to sync one Application from the tree again, `task localdev:sync -- --only <app>`.

### Fakes

`localdev/fakes/` (applied by `task localdev:kind`, re-applied by `task localdev:fakes`)
provides what Kind lacks so every Application reaches Healthy:

| File | Provides |
|------|----------|
| `storageclasses.yaml` | `democratic-csi-nfs`, `-ssd`, `-iscsi`, `-iscsi-hdd` backed by `rancher.io/local-path` (WaitForFirstConsumer), so a chart that names a homelab class still binds |
| `secrets.yaml` | Namespaces (with the charts' pod-security labels) and every Secret a localdev-enabled app references by name but nothing renders, e.g. `media/plex` with a throwaway claim token. TLS Secrets are never seeded: the self-signed issuer creates them |
| `onepassworditem-crd.yaml` | The `onepassworditems.onepassword.com` CRD from the pinned connect chart, so a stray OnePasswordItem is accepted instead of failing the sync |

`localdev/fakes/README.md` explains how to add an entry (grep the localdev snapshots for
`existingSecret`/`claimSecret`/`secretName`).

### Registry pull-through caches

`task localdev:kind` starts one `registry:2` container per upstream (`docker.io`,
`ghcr.io`, `quay.io`, `registry.k8s.io`, `lscr.io`) on the `kind` Docker network, named
`kind-registry-<name>`, with blobs under `$HOMELAB_KIND_CACHE_DIR` (default
`$XDG_CACHE_HOME/homelab-kind-registry`, i.e. `~/.cache/homelab-kind-registry`). It writes
`/etc/containerd/certs.d/<host>/hosts.toml` into every node pointing pulls at the cache
with the upstream as fallback, so an empty, stopped or purged cache only costs pull time.
Recreating the cluster keeps the cache; `task localdev:down -- --purge-cache` removes it.
CI restores the same directory with `actions/cache`. `--no-registry` skips all of it.

### Cilium in Kind

`localdev/kind-config.yaml` sets `disableDefaultCNI: true`; `task localdev:kind` installs
Cilium with `helm upgrade --install` at `charts.cilium` from `versions.yaml`, using the
`cilium.values` block from `charts/addons/values-localdev.yaml` (`kubeProxyReplacement`
off, `ipam.mode: kubernetes`, no Hubble, one operator replica). The `cilium` ArgoCD
Application renders the same chart version and the same values, so its first sync adopts
the release as a no-op. `tests/e2e/cilium-netpol` proves NetworkPolicy enforcement works.

### Health checks, smoke hooks and e2e

- **Health Lua** (`charts/bootstrap/files/health/<group>_<kind>.lua`) is the single source:
  the bootstrap chart injects each file into `argocd-cm` for homelab and `task
  localdev:argocd` passes the same files with `--set-file`. `task test:health` evaluates
  every file against `tests/health/` fixtures with the pinned `argocd` CLI, no cluster
  needed.
- **PostSync smoke hooks**: each enabled application (and Grafana plus Prometheus in
  kube-prometheus-stack) renders a Job `smoke-<app>` with `argocd.argoproj.io/hook: PostSync` and
  `hook-delete-policy: BeforeHookCreation,HookSucceeded` that curls `<app>.smoke.url` until
  a code in `<app>.smoke.expect` comes back (`curlimages/curl` at `images.curl` from
  `versions.yaml`). A sync only reaches `Succeeded` once the endpoint answers. The
  `smoke:` blocks live in `charts/{addons,applications}/values.yaml` and in the config
  templates (same Service URLs in both environments), for example
  `http://plex-plex-media-server.media.svc.cluster.local:32400/identity` for Plex,
  `http://nzbget.media.svc.cluster.local:10057/` with `expect: ["200", "401"]` for NZBGet
  (basic auth), `home-assistant` `/api/` also accepting 401, `/ping` for the *arr apps;
  `smoke.enabled: false` opts out (mosquitto has no HTTP).
- **Chainsaw e2e** (`tests/e2e/<name>/chainsaw-test.yaml`): assert the Applications are
  Healthy/Succeeded, then exercise the feature from inside the cluster (curl through the
  Traefik Service with `Host: <app>.homelab.local`, a TCP connect for mosquitto, a
  CloudNativePG Cluster, a NetworkPolicy). `tests/e2e/README.md` has the layout and the
  recipe for a new app. Paperclip runs in Kind too (operator, CloudNativePG `Cluster`
  `paperclip-db` on local-path, `Instance`); its two Secrets `paperclip-auth` and
  `paperclip-api-keys` come from `localdev/fakes/secrets.yaml`.

---

## Tilt Modes

Tilt is optional. `localdev/Tiltfile` has two modes, selected with `tilt up --
--mode=<mode>` (Tiltfile argument, wins) or `TILT_MODE=<mode>` (environment fallback).
Both need the Kind cluster first (`task localdev:kind`).

### Direct Mode (Default)

**Use Case**: fastest iteration on a single third-party chart, no ArgoCD.

Tilt installs local-path-provisioner, Traefik (NodePort 30080/30443) and cert-manager
straight into Kind with `helm_resource`; kube-prometheus-stack is defined but disabled
(`tilt enable kube-prometheus-stack`).

```bash
tilt up                 # from localdev/, or from the repo root
task localdev:tilt
```

### ArgoCD Mode

**Use Case**: the real loop, with Tilt re-syncing on every chart change.

The mode wraps the Taskfile loop in Tilt resources:

| Tilt resource | Runs | Trigger |
|---|---|---|
| `argocd-install` | `task localdev:argocd` | on `tilt up` |
| `argocd-sync` | `task localdev:sync` | automatically whenever `charts/` or `configuration/` change |
| `argocd-wait` | `task localdev:wait` | manual (`tilt trigger argocd-wait`) |
| `argocd-diagnose` | `task localdev:diagnose` | manual |

```bash
tilt up -- --mode=argocd
task localdev:tilt:argocd
```

**Architecture**:

```
File change under charts/ or configuration/ -> Tilt triggers argocd-sync
  -> task localdev:sync (argocd app sync --local, tier by tier) -> ArgoCD applies
  -> tilt trigger argocd-wait for a verdict, or task verify:text LEVEL=2
```

### Switching Modes

```bash
tilt down                  # stops Tilt; the cluster and everything ArgoCD deployed stay
tilt up -- --mode=argocd   # or plain `tilt up` for direct mode
```

Direct-mode Traefik and the ArgoCD-mode Traefik Applications both want the `traefik`
namespace, so `task localdev:down && task localdev:kind` between modes is the clean path.

---

## Development Workflow

> **Note:** `charts/addons/values-localdev.yaml` and `charts/applications/values-localdev.yaml`
> are generated, not hand-written. `task config:export:localdev` renders them from
> `configuration/environments/localdev.yaml` + `configuration/templates/helm-{addons,apps}.tmpl`,
> and level 0 (`task verify`, check `render/localdev/_committed-values`) fails when the
> committed files are stale. Edit the source, regenerate, commit both.

### Typical Development Cycle

```
1. Edit a chart template, a config template or configuration/environments/localdev.yaml
2. task config:export:localdev          (only when configuration/ changed)
3. task verify:text                     (level 0, seconds; task test:snapshot -- --update if intended)
4. task localdev:sync                   (or let Tilt in ArgoCD mode do it)
5. task verify:text LEVEL=2             (or task localdev:wait + task test:e2e)
6. Commit; CI re-runs level 0 and the whole loop
```

### Example: Modify Traefik Configuration

**Step 1**: Edit the source, not the generated file

- A config value (domain, hostname, a platform capability such as `LOAD_BALANCER_ENABLED`):
  `configuration/environments/localdev.yaml`
- A Kind sizing block (replicas, resources, retention): `configuration/templates/helm-addons.tmpl`,
  inside the `{{ if eq .Set "localdev" }}` branch

```yaml
# configuration/templates/helm-addons.tmpl, localdev branch
traefikExternal:
  resources:
    requests:
      cpu: 100m  # Changed from 50m
      memory: 256Mi  # Changed from 128Mi
```

**Step 2**: Regenerate the committed values file and check it renders

```bash
task config:export:localdev   # rewrites charts/addons/values-localdev.yaml
task verify:text              # level 0
```

**Step 3**: Sync the working tree into Kind

```bash
task localdev:sync -- --only traefik-external
kubectl --context kind-homelab-localdev -n traefik get pods -o yaml | rg -A5 'resources:'
```

**Step 4**: Verify and commit both files together

```bash
task verify:text LEVEL=2
git add configuration/templates/helm-addons.tmpl charts/addons/values-localdev.yaml tests/snapshots
git commit -m "feat(traefik): raise Kind resource requests"
```

### Example: Add a New Application

1. Add the chart under `charts/<name>` and its Application template to
   `charts/applications/templates/<name>.yaml` (finalizer, sync-wave, `ServerSideApply=true`,
   the `{{- if .Values.global.automatedSync }}` wrapper around `automated:`, and the
   `homelab.smokeJob` include at the end).
2. Add its values block to `configuration/templates/helm-apps.tmpl`, keyed on capability
   keys for anything Kind lacks (`STORAGE_PROVIDER`, `MEDIA_PROVIDER`, `SECRETS_PROVIDER`,
   `LOAD_BALANCER_ENABLED`), with a `smoke:` block (`enabled`, `url`, `expect`). Then
   `task config:export:localdev`.
3. If it references a Secret that 1Password provides in homelab, seed it by name in
   `localdev/fakes/secrets.yaml`; if it brings a new custom resource kind, add health Lua
   and fixtures (`tests/health/README.md`).
4. Add `tests/e2e/<name>/chainsaw-test.yaml` (copy `tests/e2e/sonarr`, change host, gateway,
   path and expected codes).
5. `task verify:text`, `task test:snapshot -- --update`, `task localdev:sync`,
   `task verify:text LEVEL=2`.

---

## Testing Strategies

### Level 0: static (no cluster)

```bash
task verify:text   # render + kubeconform + gitops graph + snapshots + policy, < 5 s
task test:health   # health Lua fixtures (needs the argocd CLI, no cluster)
```

See `docs/runbooks/verification.md` for every check name.

### Level 1: server-side dry run (Kind, no ArgoCD needed)

```bash
task localdev:kind
task verify:text LEVEL=1   # dryrun/localdev/<chart> for every rendered localdev chart
```

Catches what kubeconform cannot: admission webhooks, CRD versions the vendored schema does
not model, missing namespaces or StorageClasses.

### Level 2: Application health and e2e (Kind, synced)

```bash
task localdev:up && task localdev:wait
task verify:text LEVEL=2   # argocd/<app> + e2e/<test>
task test:e2e -- --test-dir tests/e2e/plex   # one chainsaw test with full output
```

### Direct chart checks

```bash
helm template charts/addons -f charts/addons/values.yaml -f charts/addons/values-localdev.yaml
helm lint charts/addons
```

---

## Debugging

### Start with diagnose

```bash
task localdev:diagnose          # conditions, unhealthy resources, events, failing pod logs
task localdev:ui                # keep running: port-forward to argocd-server on localhost:8080
argocd login localhost:8080 --plaintext --insecure --grpc-web --username admin \
  --password "$(kubectl --context kind-homelab-localdev -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
argocd app get <app>            # the script's own port-forward (127.0.0.1:18080) lives only while it runs
argocd app diff <app>           # live vs GitHub main (expect differences after a local sync)
argocd app sync <app> --local charts/<path> --local-repo-root . --prune   # what task localdev:sync runs
```

### Tilt UI

**Access**: http://localhost:10350 (ArgoCD mode: the `argocd-*` resources carry the task logs;
`tilt trigger argocd-sync|argocd-wait|argocd-diagnose` re-runs one).

### Kubectl

```bash
K="kubectl --context kind-homelab-localdev"
$K get pods -A
$K -n argocd get applications -o wide
$K describe pod -n traefik <pod>
$K logs -n traefik <pod> --all-containers --previous
$K get events -n <ns> --sort-by='.lastTimestamp' | tail -30
$K run -it --rm debug --image=nicolaka/netshoot --restart=Never -- bash
```

### Reaching an app from the host

Traefik has no LoadBalancer in Kind, so port-forward the Traefik Service and send the
`Host` header (or port-forward the app's own Service):

```bash
task localdev:traefik   # Traefik internal on localhost:9080 / 9443 (keep it running)
curl -sk -H 'Host: sonarr.homelab.local' https://localhost:9443/ping
```

On Linux the Kind mappings of container ports 80/443 to host 9080/9443 also work without
the task; on macOS they do not (see [Host ports on macOS](#host-ports-on-macos)).

### Helm

```bash
helm get values argocd -n argocd --kube-context kind-homelab-localdev   # what task localdev:argocd installed
helm get values cilium -n kube-system --kube-context kind-homelab-localdev
```

### Common Issues

**Application stuck `Progressing`**: `task localdev:diagnose`. Usually a pod that cannot pull
(check `task localdev:registry -- status` and the events) or a PVC waiting for a consumer
(`WaitForFirstConsumer` is normal until the pod schedules).

**`argocd app sync --local` refused**: the Application has `syncPolicy.automated`. Every
localdev render must set `global.automatedSync: false`; re-run `task config:export:localdev`
and check `charts/*/values-localdev.yaml`.

**Sync tier times out**: `task localdev:sync -- --only <app>` after fixing the cause; the
tier table printed by the script names the app and its operation phase.

**Kind cluster out of resources**: `docker stats`; raise Docker Desktop CPU/RAM; or use
`task localdev:warm` and sync only the applications you work on with `--only`.

**Ports in use**: host 8080 (ArgoCD, `task localdev:ui`), 9080/9443 (Traefik, `task
localdev:traefik`), 10350 (Tilt); ArgoCD NodePort 30080, mosquitto NodePorts 31883/31901,
spegel 30021.

**`localhost:8080` or `:9080` hangs on macOS**: expected with Cilium on Docker Desktop;
use `task localdev:ui` / `task localdev:traefik` ([Host ports on macOS](#host-ports-on-macos)).

---

## CI Integration

`.github/workflows/tilt-ci.yml` runs on every pull request that touches `charts/`,
`localdev/`, `scripts/`, `configuration/`, `tests/e2e/`, `tests/health/`, `Taskfile.yml`,
`cmd/`, `internal/` or `mise.toml`:

| Job | What it runs | Required |
|-----|--------------|----------|
| `kind-argocd` | pinned tools from `versions.yaml` (kind, kubectl, helm, argocd, chainsaw, tilt, task, deno), `actions/cache` on `~/.cache/homelab-kind-registry`, `task localdev:ci`, `task verify LEVEL=2` (JSON to the Job Summary and the `verify-level2` artifact), `task localdev:diagnose` on every outcome, then `task localdev:report` as the sticky PR comment `kind-preview` (same-repo PRs; never decides the check). 45 minute budget. | yes |
| `kind-direct` | `task localdev:kind -- --no-registry`, `tilt ci --timeout 15m` in direct mode, asserts the Traefik and cert-manager Deployments | |
| `yaml-lint` | `yamllint` over `charts/`, `localdev/`, `tests/e2e`, `tests/health` | |

Level 0 runs separately in `.github/workflows/verify.yml`.

### Run the CI loop locally

```bash
task localdev:down
task localdev:ci                       # kind -> argocd -> sync -> wait -> e2e
task verify LEVEL=2 | tee verify-level2.json
jq '.checks[] | select(.status != "pass")' verify-level2.json
```

---

## Troubleshooting

### Kind Cluster Issues

**Symptom**: `task localdev:kind` cannot create the cluster

```bash
docker ps                                   # Docker running?
kind get clusters
kind delete cluster --name homelab-localdev
task localdev:kind
```

**Symptom**: nodes stay NotReady: Cilium did not come up. `kubectl --context
kind-homelab-localdev -n kube-system get pods -l k8s-app=cilium` and the Cilium install
log printed by the script.

### ArgoCD Issues

**Symptom**: `task localdev:argocd` cannot log in: `argocd-server` is not ready yet; the
script retries for 2 minutes through its own `kubectl port-forward` on `127.0.0.1:18080`.
Check `kubectl --context kind-homelab-localdev -n argocd get pods` and that nothing else
listens on 18080 (or pass `--local-port`).

**Symptom**: every Application `Unknown`: the root Application cannot fetch GitHub `main`
(offline). The local sync still works for children once the root app has been synced
once; run `task localdev:sync -- --only gitops` when back online.

### Storage Issues

**Symptom**: PVCs stuck in Pending

```bash
kubectl --context kind-homelab-localdev get storageclass       # local-path + democratic-csi-* aliases
kubectl --context kind-homelab-localdev -n local-path-storage get pods
task localdev:fakes                                            # re-apply the aliases
```

### Tilt Issues

**Symptom**: Tilt shows an error on `argocd-sync`: open the resource log; it is the
`task localdev:sync` output. Fix, then `tilt trigger argocd-sync`.

---

## References

- [Kind](https://kind.sigs.k8s.io/) · [ArgoCD CLI: app sync --local](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_sync/) · [Chainsaw](https://kyverno.github.io/chainsaw/) · [Cilium](https://docs.cilium.io/) · [Tilt](https://docs.tilt.dev/) · [Taskfile](https://taskfile.dev/)
- [verification runbook](./runbooks/verification.md), [architecture](./architecture.md), [networking](./networking.md)
- `localdev/fakes/README.md`, `tests/e2e/README.md`, `tests/health/README.md`
- ADR-009 (agents mutate only Kind), ADR-011 (capability keys), ADR-012 (this loop) in `docs/project_notes/decisions.md`

---

**Last Updated**: 2026-09-13 (issue #261 Section B)
