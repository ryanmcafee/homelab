# OpenClaw level-2 suite (MCAA-291)

The dedicated test lives at `tests/e2e/openclaw/`; its README is the reusable acceptance checklist.
It uses Chainsaw's `concurrent: false` because negative Argo health and API-key reconvergence mutate
only the Kind instance. Application discovery needs no registration list: test name `openclaw`
becomes `e2e/openclaw` in the verifier's JSON.

The original smoke hook is deleted on success. Its own Argo per-resource hook result plus a retained
replay of the rendered helper provide distinct evidence. Neither a healthy Application nor mounted
OAuth credentials establish successful provider authentication. Placeholder credentials leave that
assertion to separately authorized post-merge verification.

Source branch: test/mcaa-291-openclaw-e2e, rebased onto PR #434 head f78d976.
No local Kind run is attempted on the agent runner without a container runtime.

Adding a discovered suite also requires `bun scripts/docs-check.ts --fix` to refresh the
application inventory and README counts, plus updating `.github/homelab.svg` suite count by hand.
PR #504 CI run 36487720200 caught these stale entries at `task docs:check`; level-0 verification
alone does not include that documentation check. This is a documentation failure, not live evidence.
