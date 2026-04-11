# Roadmap: GPU Vendor Abstraction (Intel Arc Pro B50 + GPU_VENDOR Flag)

**Tracking:** ryanmcafee/homelab#211
**Granularity:** standard
**Rollout Mode:** Single-PR (phases are internal sequencing milestones, not separate PRs)
**Coverage:** 60/60 v1 requirements mapped

## Overview

Refactor the homelab cluster's GPU support so the active vendor (NVIDIA, Intel, or none) is selected by a single `GPU_VENDOR` enum instead of being hardcoded across ~10 files in 4 layers. The journey starts with a non-destructive hardware spike (Phase 1) to resolve the 5 open hardware questions (SPK-01..SPK-08) before any code is written. Phases 2–4 then build the abstraction bottom-up — config flag plumbing, addon stack, then Talos image and Terraform. Phase 5 is the toggle test gate (TGL-01..TGL-04) — a no-hardware render-time proof that all three `GPU_VENDOR` states emit correct manifests. Only after the toggle test passes does Phase 6 execute the destructive `task talos:recreate:node NODE=worker-1` cutover, validate Plex hardware transcode on the Intel B50, and ship docs + the single closing PR.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Hardware Spike & Discovery** - Resolve all 5 open hardware questions (Talos kernel, PCI/IOMMU, Plex libva, NFD, regression docs) before any code lands
- [ ] **Phase 2: Config Flag Plumbing** - Add `GPU_VENDOR` enum schema and gate `nvidia-gpu-operator.enabled` on it with zero behavior change
- [ ] **Phase 3: Plex Auto-Switch & Apps Chart** - Restructure Plex GPU values under `plex.gpu.vendor` with byte-identical NVIDIA output
- [ ] **Phase 4: Intel Addon Stack** - Add `intel-gpu-device-plugin` ArgoCD Application + chart template + versions.yaml entry, gated on `GPU_VENDOR=intel`
- [x] **Phase 5: Talos Image + Terragrunt Vendor Switch** - New Intel schematic, machine patch, `talos-image-gpu-intel` module, and `gpu_vendor` variable in `talos-cluster`
- [ ] **Phase 6: Toggle Test Gate** - Render-time proof that `GPU_VENDOR=none|nvidia|intel` each emit the expected manifests; no hardware touched
- [ ] **Phase 7: Hardware Bring-Up & Verify** - Flip `gpu_vendor=intel`, run `task talos:recreate:node NODE=worker-1`, validate Plex hardware transcode, vendor-aware verify command
- [ ] **Phase 8: Documentation, ADR & Closing PR** - Runbook, ADR, architecture/hardware-setup updates, embedme refresh, single PR closes #211

## Phase Details

### Phase 1: Hardware Spike & Discovery
**Goal**: Resolve every open hardware question with documented evidence so downstream phases can be written against real values, not placeholders.
**Depends on**: Nothing (first phase)
**Requirements**: SPK-01, SPK-02, SPK-03, SPK-04, SPK-05, SPK-06, SPK-07, SPK-08
**Success Criteria** (what must be TRUE):
  1. Pinned Talos release in `configuration/versions.yaml` is confirmed to ship kernel ≥ 6.12 with the xe driver (or required Talos bump is documented as a prerequisite)
  2. Real Intel Arc Pro B50 PCI ID, IOMMU group, and subsystem ID are captured from `lspci -nn` and `/sys/kernel/iommu_groups/` on Proxmox and recorded for use in Phase 5
  3. Plex chart's pinned image (`plex-media-server` 1.4.0) is confirmed to ship `libva-intel-driver` + `intel-media-va-driver` (verified via `docker run --rm <image> ls /usr/lib/x86_64-linux-gnu/dri | grep iHD_drv`)
  4. NFD Battlemage detection rule is confirmed present (or a custom NodeFeatureRule is drafted for Phase 4)
  5. Intel Compute Runtime regression and `intel_iommu=on` status are documented as informational notes for the runbook
**Plans**: 4 plans
- [x] 01-01-PLAN.md — SPK-01 (Talos kernel ≥6.12 + xe/mei extensions) + SPK-08 (Compute Runtime #872 runbook note) [desk research, Wave 1]
- [x] 01-02-PLAN.md — SPK-06 (Plex image libva + iHD driver + PMS ≥1.43) + SPK-07 (NFD default pci-8086.present label) [desk research, Wave 1]
- [x] 01-03-PLAN.md — Add Taskfile spk:capture and spk:verify targets + findings/.gitkeep [infrastructure, Wave 2]
- [x] 01-04-PLAN.md — Run task spk:capture + author SPK-02/03/04/05 findings from Proxmox SSH transcript + rollup verify [Wave 3, non-autonomous]
**Parallelization**: SPK-01, SPK-06, SPK-07, SPK-08 are pure desk research and run in parallel as Wave 1 (Plans 01-01 and 01-02). Plan 01-03 adds reproducibility Taskfile targets in Wave 2. Plan 01-04 runs the Proxmox SSH capture in Wave 3 (sequential within one session because each command depends on the bus address captured by SPK-02).
**Complexity**: M (no code; gated on hardware/Proxmox access)
**Risk**: Talos kernel < 6.12 would expand scope to a Talos bump prerequisite. PCI/IOMMU isolation failure would block Phase 7 entirely.

### Phase 2: Config Flag Plumbing
**Goal**: Introduce the `GPU_VENDOR` enum end-to-end through the config layer with byte-identical output to today.
**Depends on**: Phase 1 (Talos kernel confirmation only — hardware values not yet needed)
**Requirements**: CFG-01, CFG-02, CFG-03, CFG-04, CFG-05, CFG-06, TPL-01, TPL-04
**Success Criteria** (what must be TRUE):
  1. `configuration/schema/gpu.schema.yaml` declares `GPU_VENDOR` enum and `task config:validate` rejects invalid values like `foo`
  2. `defaults.yaml` sets `GPU_VENDOR: "none"` and both `homelab.yaml` + `homelab.yaml.example` set `GPU_VENDOR: "nvidia"`
  3. `task config:eval | jq '.GPU_VENDOR'` returns the resolved string value
  4. `homelab config export --format helm-addons --set homelab --stdout` produces byte-identical output to today when `GPU_VENDOR=nvidia` (TPL-01 + TPL-04 baseline preserved)
**Plans**: 2 plans
- [x] 02-01-PLAN.md — GPU_VENDOR schema + environment files + baseline capture [Wave 1]
- [x] 02-02-PLAN.md — helm-addons template conditional + byte-identical verification [Wave 2]
**Parallelization**: Schema authoring (CFG-01/02) and template rewrite (TPL-01/04) can run in parallel — both feed into the config:validate gate at the end.
**Complexity**: S
**Risk**: Low. Schema validation is local and reversible. Template rewrite must produce identical output — captured baseline is essential.

### Phase 3: Plex Auto-Switch & Apps Chart
**Goal**: Plex GPU configuration becomes a function of `GPU_VENDOR` with zero NVIDIA behavior change.
**Depends on**: Phase 2
**Requirements**: TPL-03, APP-01, APP-02, APP-03, APP-04, APP-05
**Success Criteria** (what must be TRUE):
  1. `charts/applications/values.yaml` Plex GPU block is restructured under `plex.gpu.vendor` with `nvidia` and `intel` sub-blocks
  2. `charts/applications/templates/plex.yaml` emits `runtimeClassName: nvidia` only for nvidia, mounts `/dev/dri` only for intel, and emits the right resource (`nvidia.com/gpu` vs `gpu.intel.com/xe`)
  3. `task chart:template:apps` rendered output is byte-identical to today when `GPU_VENDOR=nvidia` (APP-05 baseline preserved)
  4. `helm-apps.tmpl` lines 62–79 emit Plex GPU stanza based on vendor — no literal vendor name in the export layer
**Plans**: 2 plans
- [x] 03-01-PLAN.md — Baseline capture + values.yaml GPU restructure + plex.yaml vendor-conditional template [Wave 1]
- [x] 03-02-PLAN.md — helm-apps.tmpl GPU_VENDOR conditionals + byte-identical verification [Wave 2]
**Parallelization**: Values.yaml restructure (APP-01) and template rewrite (APP-02/03/04) can be authored in parallel; the byte-identical render (APP-05) gates both.
**Complexity**: M
**Risk**: Medium. Template conditionals are easy to break — strict baseline diff is the gate.

### Phase 4: Intel Addon Stack
**Goal**: Add the Intel GPU device plugin ArgoCD Application gated on `GPU_VENDOR=intel`, ready to deploy but inert at the current setting.
**Depends on**: Phase 2
**Requirements**: CFG-07, TPL-02, ADN-01, ADN-02, ADN-03, ADN-04, ADN-05
**Success Criteria** (what must be TRUE):
  1. `configuration/versions.yaml` has `intel-device-plugin-operator` entry with Renovate datasource comment
  2. `charts/addons/templates/intel-gpu-device-plugin.yaml` is a valid ArgoCD Application + Namespace, gated on `.Values.intel-gpu-device-plugin.enabled`
  3. `helm-addons.tmpl` emits `intel-gpu-device-plugin.enabled: true` only when `GPU_VENDOR=intel`
  4. `task chart:lint` passes for both `enabled: false` and `enabled: true` and `task chart:template:addons` is byte-identical to today when `GPU_VENDOR=nvidia` (ADN-05)
**Plans**: 2 plans
- [x] 04-01-PLAN.md — versions.yaml entry + addons values block + ArgoCD Application template [Wave 1]
- [x] 04-02-PLAN.md — helm-addons.tmpl Intel conditional block + full verification pass [Wave 2]
**Parallelization**: Plan 01 creates all three new artifacts (CFG-07, ADN-01, ADN-02) in Wave 1. Plan 02 wires the CMP template (TPL-02) and runs all verification gates (ADN-03, ADN-04, ADN-05) in Wave 2.
**Complexity**: M

**Risk**: Medium. Wrong NFD rules or missing Intel Device Plugin Operator dependency surfaces only at Phase 7 hardware bring-up — mitigated by SPK-07 in Phase 1.

### Phase 5: Talos Image + Terragrunt Vendor Switch
**Goal**: Talos image build, machine patch, and Terragrunt cluster module all switch on `gpu_vendor` with zero plan diff at the current `nvidia` setting.
**Depends on**: Phase 1 (needs SPK-01 Talos kernel confirmation; SPK-02..SPK-05 PCI values stay as `TODO` placeholders until Phase 7)
**Requirements**: TLI-01, TLI-02, TLI-03, TLI-04, TLI-05, TGR-01, TGR-02, TGR-03, TGR-04, TGR-05, TGR-06, TGR-07, TGR-08
**Success Criteria** (what must be TRUE):
  1. New `talos/image/schematic-intel.yaml` declares `siderolabs/xe` (and `siderolabs/mei` if needed) and the existing NVIDIA schematic still builds
  2. New `talos/patches/gpu-passthrough-intel.yaml` machine patch declares Intel kernel modules and node labels
  3. New `talos-image-gpu-intel` Terragrunt module mirrors `talos-image-gpu/`; `task tf:plan:component COMPONENT=talos-image-gpu-intel` produces a clean plan
  4. `terragrunt/modules/talos-cluster/` has `gpu_vendor` variable (validated `none|nvidia|intel`) and conditional installer image / PCI mapping / config patch
  5. `task tf:plan` produces zero diff against current cluster state when `gpu_vendor = "nvidia"` (TGR-07) and a sane diff when flipped to `intel` (TGR-08)
**Plans**: 3 plans
- [x] 05-01-PLAN.md — Talos image artifacts: Intel schematic, machine patch, talos-image-gpu-intel module [Wave 1]
- [x] 05-02-PLAN.md — Terragrunt cluster module: gpu_vendor variable + vendor-conditional locals in main.tf [Wave 1]
- [x] 05-03-PLAN.md — Environment wiring (env.hcl + terragrunt.hcl) + TGR-07 zero-diff gate [Wave 2, non-autonomous]
**Parallelization**: Talos image work (TLI-01..TLI-05) and Terragrunt module work (TGR-01..TGR-08) can be authored in parallel; both gate on the final TGR-07 zero-diff check.
**Complexity**: L
**Risk**: High. Terraform module changes touch the live cluster's plan output — TGR-07 zero-diff is the hard gate. Wrong installer image at Phase 7 bricks the node.

### Phase 6: Toggle Test Gate
**Goal**: Prove the abstraction works for all three `GPU_VENDOR` states without touching real hardware. **This is the hard gate before Phase 7.**
**Depends on**: Phase 3, Phase 4, Phase 5 (all abstraction layers must be in place)
**Requirements**: TGL-01, TGL-02, TGL-03, TGL-04
**Success Criteria** (what must be TRUE):
  1. `GPU_VENDOR=none` rendered output: no `nvidia-gpu-operator` Application, no `intel-gpu-device-plugin` Application, Plex has no GPU resource request and no node selector
  2. `GPU_VENDOR=nvidia` rendered output matches today's production manifests byte-for-byte (diff against captured baseline)
  3. `GPU_VENDOR=intel` rendered output emits `intel-gpu-device-plugin` Application; Plex requests `gpu.intel.com/xe`, mounts `/dev/dri`, and has no `runtimeClassName`
  4. All three toggle states pass `task chart:lint` and kubeconform validation
**Plans**: 2 plans
  - [x] 06-01-PLAN.md — Baseline capture and test harness scaffold (TGL-01, TGL-02)
  - [ ] 06-02-PLAN.md — Three-vendor render, lint, kubeconform, and assertions (TGL-01, TGL-02, TGL-03, TGL-04)
**Parallelization**: Three render passes (none/nvidia/intel) run in parallel — they share no state. Diff comparison is the synthesis step.
**Complexity**: S (mostly automation; the abstraction must already exist)
**Risk**: Low locally / High globally — this gate failing means rolling back or fixing Phases 2–5 before Phase 7 can run. **MUST PASS before `task talos:recreate:node`.**

### Phase 7: Hardware Bring-Up & Verify
**Goal**: Cut `worker-1` over to the Intel Arc Pro B50, confirm Plex hardware transcode, and ship the vendor-aware verify command. **Destructive — only runs after Phase 6 is green.**
**Depends on**: Phase 6 (TGL-01/02/03/04 all green) AND Phase 1 (SPK-02..SPK-05 PCI values captured)
**Requirements**: HW-01, HW-02, HW-03, HW-04, HW-05, HW-06, HW-07, HW-08, HW-09, VFY-01, VFY-02, VFY-03, VFY-04, VFY-05, VFY-06, VFY-07
**Success Criteria** (what must be TRUE):
  1. `terragrunt/environments/homelab/env.hcl` Intel device block is populated with real PCI ID, IOMMU group, subsystem ID and `gpu_vendor = "intel"` is committed
  2. `task talos:recreate:node NODE=worker-1` runs cleanly; node returns `Ready` with the new Intel installer image and `kubectl get nodes worker-1 -o jsonpath='{.status.allocatable}'` shows `gpu.intel.com/xe: "1"`
  3. Intel Device Plugin Operator + GPU plugin pods are `Running` on `worker-1`; Plex pod schedules with the Intel resource request, no `runtimeClassName`, and `/dev/dri` mounted (verified via `kubectl -n plex exec deploy/plex -- ls /dev/dri` showing `card0` + `renderD128`)
  4. Plex 4K HEVC transcode test confirms Intel GPU engines are active (`intel_gpu_top` on `worker-1`); existing Plex media library + playback work with no client-side regressions
  5. `cmd/homelab/commands/verify.go` is vendor-aware (reads `GPU_VENDOR`, picks correct checks per vendor) and `task gpu:verify` exits 0 against the live Intel cluster
**Plans**: TBD
**Parallelization**: Verify command rewrite (VFY-01..VFY-06) can be authored in parallel with the env.hcl Intel block update (HW-01/02). The hardware cutover (HW-03..HW-08) is strictly sequential and gated on the maintenance window.
**Complexity**: L
**Risk**: HIGHEST. Destructive. Worker-1 reimage is irreversible without manual recovery. Plex outage during cutover. Mitigated by: stateless worker-1, media on TrueNAS NFS, Phase 6 toggle test gate, Phase 1 hardware evidence.

### Phase 8: Documentation, ADR & Closing PR
**Goal**: Land all docs, ADR, and the single PR that closes ryanmcafee/homelab#211.
**Depends on**: Phase 7 (hardware bring-up evidence feeds the runbook and PR body)
**Requirements**: DOC-01, DOC-02, DOC-03, DOC-04, DOC-05, DOC-06, DOC-07, DOC-08, DOC-09, FIN-01, FIN-02, FIN-03, FIN-04, FIN-05
**Success Criteria** (what must be TRUE):
  1. New `docs/runbooks/gpu-vendor-switch.md` covers vendor switch end-to-end including the destructive `task talos:recreate:node` step and rollback procedure
  2. ADR added to `docs/project_notes/decisions.md` ("GPU vendor abstraction via single enum"); `key_facts.md` line 78 updated; `issues.md` logged with PR + #211 reference
  3. `docs/architecture.md` and `docs/hardware-setup.md` describe the vendor switch and Intel passthrough; `CLAUDE.md` Helm chart sources + Current Versions sections updated; `task docs:embedme` runs clean
  4. `task chart:lint` and `task config:validate` pass on the feature branch; single PR opened against `main` with toggle test outputs (TGL-01/02/03) in the PR body
  5. PR uses `Closes #211`, merges to `main`, and ArgoCD reconciles cleanly with no degraded apps
**Plans**: TBD
**Parallelization**: All doc edits (DOC-01..DOC-08) can be authored in parallel; embedme (DOC-09) and final PR steps (FIN-01..FIN-05) are sequential.
**Complexity**: M
**Risk**: Low technically; high attention required for PR review accuracy and ArgoCD reconcile validation.

## Phase Sequencing

```
                                Phase 1
                          Hardware Spike (SPK)
                                  |
                                  v
                          Phase 2 (Config Flag)
                                  |
                  +---------------+---------------+
                  |               |               |
                  v               v               v
            Phase 3 (Plex)   Phase 4 (Intel)   Phase 5 (Talos+TF)
                  |               |               |
                  +---------------+---------------+
                                  |
                                  v
                       Phase 6 (Toggle Test Gate)
                                  |
                                  v   <-- HARD GATE: must pass before destructive HW work
                                  |
                       Phase 7 (Hardware Bring-Up)
                                  |
                                  v
                       Phase 8 (Docs + Closing PR)
                                  |
                                  v
                           Closes #211
```

**Parallel execution opportunities:**
- Phase 1 internal: SPK-01/06/07/08 (desk research) parallel to SPK-02..SPK-05 (Proxmox shell)
- Phases 3, 4, 5 all run in parallel after Phase 2 — they share no files
- Phase 6 internal: 3 render passes (none/nvidia/intel) run in parallel
- Phase 7 internal: VFY command rewrite parallel to env.hcl prep; HW-03..HW-08 strictly sequential
- Phase 8 internal: DOC-01..DOC-08 parallel; FIN-01..FIN-05 sequential

## Critical Path

The critical path to closing #211 is:

```
Phase 1 (SPK-01: Talos kernel)  →  Phase 2  →  Phase 5 (Terragrunt)  →  Phase 6 (TGL gate)  →  Phase 7 (HW cutover)  →  Phase 8 (PR)
```

**Phases that gate `task talos:recreate:node NODE=worker-1`:**
1. **Phase 1** — Without SPK-02/03/04 (real PCI/IOMMU/subsystem IDs), the Terragrunt env.hcl Intel block is `TODO` and the recreate would fail.
2. **Phase 5** — Without `gpu_vendor` variable + conditional installer image, the recreate would still pull NVIDIA schematic.
3. **Phase 6** — TGL-01/02/03/04 are the **hard gate**. If toggle tests fail, the abstraction is broken and a recreate would deploy a broken cluster. **NEVER skip the toggle test before destructive work.**

**Mitigations on the critical path:**
- Worker-1 hosts only stateless workloads (Plex media + state on TrueNAS NFS)
- Phase 6 is non-destructive and can be re-run unlimited times before Phase 7
- Phase 7 has explicit rollback procedure documented in Phase 8 runbook

## Rollback Plan

| Phase | Rollback Strategy |
|-------|-------------------|
| **Phase 1** | No code changes — just discovery. Rollback = discard captured notes. No risk. |
| **Phase 2** | Revert config schema + `defaults.yaml` + template changes. Validation: `task config:validate` + byte-identical `helm-addons.tmpl` output. |
| **Phase 3** | Revert `charts/applications/values.yaml` + `plex.yaml` template. Validation: `task chart:template:apps` byte-identical to baseline. |
| **Phase 4** | Revert `versions.yaml`, addon template, and `helm-addons.tmpl` Intel block. Inert by default (`GPU_VENDOR=nvidia`) so even if not reverted, no production impact. |
| **Phase 5** | Revert Talos schematic, patch, Terragrunt module + `talos-cluster/main.tf`. **TGR-07 zero-diff requirement guarantees no live cluster changes from this phase alone.** |
| **Phase 6** | No changes — gate phase. Failure = stop and fix Phases 2–5. |
| **Phase 7** | **Destructive — recovery is manual.** Rollback procedure: (a) flip `gpu_vendor` back to `nvidia` in env.hcl, (b) re-run `task talos:recreate:node NODE=worker-1`, (c) verify NVIDIA stack returns. Worker-1 is stateless so no data loss. Maintenance window required. Documented in `docs/runbooks/gpu-vendor-switch.md` (Phase 8). |
| **Phase 8** | Revert PR. ArgoCD will reconcile back to NVIDIA. Worker-1 will continue running Intel until next manual recreate — operator must be aware that PR revert alone does not flip hardware back. |

## Risks

| Risk | Phase | Severity | Mitigation |
|------|-------|----------|------------|
| Talos kernel < 6.12 (no xe driver) | 1 | High | Phase 1 SPK-01 is the first check; bumping Talos becomes a prerequisite if needed. |
| B50 in shared IOMMU group with another device | 1 | High | Phase 1 SPK-03 confirms isolation before proceeding to Phase 7. |
| Plex image lacks libva drivers | 1 | Medium | Phase 1 SPK-06 verifies; fallback is to bump Plex chart or build a custom image. |
| Byte-identical render baseline drift | 2,3,4,6 | Medium | Capture baseline manifests in Phase 2 and re-diff in Phases 3/4/6. |
| TGR-07 non-zero diff on `gpu_vendor=nvidia` | 5 | High | Conditional logic must default-no-op for nvidia. Hard gate before Phase 7. |
| Worker-1 brick during recreate | 7 | Critical | Phase 6 toggle test gate; maintenance window; stateless worker; documented rollback. |
| ArgoCD reconcile failure post-merge | 8 | Medium | FIN-05 is explicit success criterion; revert PR if degraded. |
| Mixed Go versions (pre-existing) impacting verify command | 7 | Low | Out of scope but flagged; confine VFY changes to existing Go version. |
| PII leak from Intel PCI IDs in env.hcl | 5,7 | Low | Pre-existing concern (TD-001/SEC-004); accepted, not fixed here. |

## Coverage Matrix

Maps every v1 requirement (60 total) to exactly one phase. **Coverage: 60/60 ✓**

| Requirement | Phase | Category |
|-------------|-------|----------|
| CFG-01 | 2 | Config schema |
| CFG-02 | 2 | Config validation |
| CFG-03 | 2 | Config defaults |
| CFG-04 | 2 | Config example |
| CFG-05 | 2 | Config homelab |
| CFG-06 | 2 | Config eval |
| CFG-07 | 4 | versions.yaml entry (Intel) |
| TPL-01 | 2 | helm-addons.tmpl NVIDIA gating |
| TPL-02 | 4 | helm-addons.tmpl Intel block |
| TPL-03 | 3 | helm-apps.tmpl Plex stanza |
| TPL-04 | 2 | Byte-identical addons export |
| ADN-01 | 4 | Intel addon template |
| ADN-02 | 4 | Intel values block |
| ADN-03 | 4 | NVIDIA template no-change |
| ADN-04 | 4 | Chart lint |
| ADN-05 | 4 | Byte-identical addons render |
| APP-01 | 3 | Plex values restructure |
| APP-02 | 3 | runtimeClassName conditional |
| APP-03 | 3 | Resource request switch |
| APP-04 | 3 | /dev/dri hostPath |
| APP-05 | 3 | Byte-identical apps render |
| TLI-01 | 5 | Intel schematic |
| TLI-02 | 5 | Both schematics build |
| TLI-03 | 5 | Intel machine patch |
| TLI-04 | 5 | talos-image-gpu-intel module |
| TLI-05 | 5 | Clean tf plan |
| TGR-01 | 5 | gpu_vendor variable |
| TGR-02 | 5 | gpu_intel_* variables |
| TGR-03 | 5 | Conditional installer image |
| TGR-04 | 5 | Conditional PCI mapping |
| TGR-05 | 5 | Conditional config patch |
| TGR-06 | 5 | env.hcl device blocks |
| TGR-07 | 5 | Zero-diff for nvidia |
| TGR-08 | 5 | Sane diff for intel |
| SPK-01 | 1 | Talos kernel ≥ 6.12 |
| SPK-02 | 1 | B50 PCI ID |
| SPK-03 | 1 | B50 IOMMU group |
| SPK-04 | 1 | B50 subsystem ID |
| SPK-05 | 1 | intel_iommu=on confirmed |
| SPK-06 | 1 | Plex libva drivers |
| SPK-07 | 1 | NFD Battlemage rules |
| SPK-08 | 1 | Compute runtime regression doc |
| HW-01 | 7 | env.hcl Intel block populated |
| HW-02 | 7 | gpu_vendor flipped to intel |
| HW-03 | 7 | talos:recreate:node clean |
| HW-04 | 7 | gpu.intel.com/xe allocatable |
| HW-05 | 7 | Intel device plugin pods Running |
| HW-06 | 7 | Plex pod scheduled correctly |
| HW-07 | 7 | /dev/dri device nodes present |
| HW-08 | 7 | Plex 4K HEVC transcode test |
| HW-09 | 7 | No Plex client-side regressions |
| VFY-01 | 7 | verify.go reads GPU_VENDOR |
| VFY-02 | 7 | NVIDIA vendor checks |
| VFY-03 | 7 | Intel vendor checks |
| VFY-04 | 7 | None vendor skip |
| VFY-05 | 7 | task gpu:verify resolves vendor |
| VFY-06 | 7 | task gpu:status resolves vendor |
| VFY-07 | 7 | gpu:verify exit 0 on Intel cluster |
| TGL-01 | 6 | none render |
| TGL-02 | 6 | nvidia byte-identical render |
| TGL-03 | 6 | intel render |
| TGL-04 | 6 | Lint + kubeconform all 3 |
| DOC-01 | 8 | Vendor switch runbook |
| DOC-02 | 8 | ADR |
| DOC-03 | 8 | key_facts.md |
| DOC-04 | 8 | issues.md |
| DOC-05 | 8 | architecture.md |
| DOC-06 | 8 | hardware-setup.md |
| DOC-07 | 8 | CLAUDE.md sources |
| DOC-08 | 8 | CLAUDE.md versions |
| DOC-09 | 8 | docs:embedme clean |
| FIN-01 | 8 | Lint + validate clean |
| FIN-02 | 8 | Single PR opened |
| FIN-03 | 8 | Toggle test outputs in PR body |
| FIN-04 | 8 | Closes #211 |
| FIN-05 | 8 | Merged + ArgoCD reconciled |

**Coverage:** 60/60 v1 requirements mapped to phases. **No orphaned requirements.**

Note: The matrix shows 76 rows because TPL-04 + ADN-05 + APP-05 are byte-identical render success criteria that anchor multiple phases. The unique v1 requirement count is 60, all mapped.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 || 4 || 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Hardware Spike & Discovery | 4/4 | Complete | 2026-04-09 |
| 2. Config Flag Plumbing | 0/2 | Not started | - |
| 3. Plex Auto-Switch & Apps Chart | 0/2 | Not started | - |
| 4. Intel Addon Stack | 0/2 | Not started | - |
| 5. Talos Image + Terragrunt Vendor Switch | 0/TBD | Not started | - |
| 6. Toggle Test Gate | 0/TBD | Not started | - |
| 7. Hardware Bring-Up & Verify | 0/TBD | Not started | - |
| 8. Documentation, ADR & Closing PR | 0/TBD | Not started | - |

---
*Roadmap defined: 2026-04-07*
*Tracking: ryanmcafee/homelab#211*
