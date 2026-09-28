# OpenClaw e2e kubeconfig repair — MCAA-613

PR #504 at 828fa2c failed before baseline inventory. Pinned Chainsaw 0.2.15
`pkg/engine/operations/script/operation.go` replaces KUBECONFIG; its
`pkg/utils/rest/config.go` Save function names the sole context `chainsaw`.
The suite pins `kind-homelab-localdev`, which is absent in that file. Real pinned
kubectl with a credential-free equivalent reproduces exit 1 and
`error: context "kind-homelab-localdev" does not exist`, before network access.

Repair: derive a private kubeconfig directly from the named local Kind cluster,
preserve the explicit context on all calls, and clean up after each invocation.
No chart behavior or live assertions changed. Reproducibility: source the named
Kind cluster rather than ambient context. Fail fast, fail loud: reject missing
Kind/context and classify subprocess errors without leaking raw output.

Regression: 2 tests / 15 assertions passed in 423 ms; includes original failure,
fixed selection, wrong-context and failed-Kind rejection, mode 0600 and cleanup,
and diagnostic suppression. Chainsaw schema lint passed. Full current-head CI
and security review remain required; real provider auth and the SSA counterfactual
remain explicitly unproven in tests/e2e/openclaw/README.md.
