# GPU Toggle Test Baseline

This directory holds the byte-identical Helm-rendered baseline for `GPU_VENDOR=nvidia` —
the production state of the cluster as of Phase 5 completion. It is the reference that
`task gpu:toggle-test` (TGL-02) compares against.

## Files

- `nvidia/addons.yaml` — `helm template addons charts/addons -f <values>` output for `GPU_VENDOR=nvidia`
- `nvidia/applications.yaml` — `helm template applications charts/applications -f <values>` output for `GPU_VENDOR=nvidia`

Each baseline is a two-stage render:

1. **Stage A — Values generation:** `homelab config export --env-file <temp-env> --format helm-addons|helm-apps --stdout`
   produces a Helm values yaml (this is what the CMP plugin does at runtime).
2. **Stage B — Helm template:** the Stage A output is piped into `helm template <release> <chart> -f -`
   to produce the final Kubernetes manifests captured here.

## NVIDIA Signals in the Baseline

Because `charts/applications` templates wrap downstream charts (e.g., truecharts plex) as ArgoCD Applications,
the baseline captures the _Application wrapper values_ — not the fully-rendered downstream pod spec.
The nvidia signals present in `applications.yaml` are:

- `runtimeClassName: nvidia` — emitted only when `GPU_VENDOR=nvidia`
- `feature.node.kubernetes.io/pci-10de.present: "true"` — nodeSelector for NVIDIA-labelled nodes
- `pms.gpu.nvidia.enabled: true` — truecharts plex chart's NVIDIA toggle

The string `nvidia.com/gpu` appears only in the _downstream_ truecharts plex render (inside the pod spec),
which is not part of this chart's helm template output.

In `addons.yaml`, the nvidia-gpu-operator ArgoCD Application is present with `enabled: true`,
and no `intel-gpu-device-plugin` Application is rendered.

## Regenerating

Only regenerate when an intentional NVIDIA-side change lands. The toggle test will
diff against these files and fail loudly if anything drifts.

```bash
task gpu:toggle-baseline:regen
```

## Captured From

- Git SHA: `1fd2e7480a05bdada553d123e24c4c6b2b49a066`
- Date: `2026-04-10`
- Phase: 5 (Talos + Terragrunt Vendor Switch) complete

## Normalization Notes

The helm-rendered output is captured as-is (no pre-normalization). If Plan 02's toggle test
discovers nondeterministic bits (timestamps, random hashes, sorted-key differences), it will
normalize at compare-time per the `<rendering_strategy>` in `06-01-PLAN.md`. Do **not**
pre-normalize the baseline.
