# Upgrade report containment — MCAA-652

## Required behavior

Before report diffs are created, remove Kubernetes Secret `data` and `stringData`,
including Secrets in nested Lists and multidocument streams. Remove the
last-applied annotation, which can duplicate a Secret payload. Preserve useful
nonsecret object changes. A malformed stream must produce a fixed failure,
never a partial diff, raw input fallback, or parser diagnostic containing input.
Helm and revalidation failures must not publish arbitrary tool output.

The same sanitized result must feed JSON, Markdown, sticky comments, job summaries
and uploaded report files. Regression fixtures are synthetic; they must run
without publishing, cluster access, credentials or upstream chart downloads.
This applies **Fail fast, fail loud**, **Shift left**, and **Reproducibility**.

## Hold and execution provenance

PR #422 remains held: no edits, rebase, push, rerun, merge or branch takeover.
No suspect report values or artifacts are needed to prove prevention. No cleanup,
rotation or production mutation is authorized. Head of Engineering and Chief of
Staff must explicitly release the hold after reviewing prevention evidence.

Read-only metadata observed 2026-09-29: draft #422 head
`c1c389e66e9fd1c0eea0acb9b1988130c769c871`, branch
`fix/paperclip-codesearch-mcp`, base `main`, mergeable `CONFLICTING`, and no
potential merge commit. Keep the codesearch #14/1.7.0 dependency.
An eventual main merge does not prove which workflow or executable report code
a later #422 push will run. Delivery must bind that conclusion to exact refs;
the current conflict prevents naming a future merge ref.

## Verification record

- Before integration of the fix, `go test ./internal/verify -run
  '^TestUpgradeReportSecretSentinel$' -count=1` failed six assertions: JSON and
  Markdown for added, deleted and changed synthetic Secrets. Wall time 2.067 s.
- After the fix, `go test ./internal/verify ./cmd/homelab/commands -run
  'Upgrade|Normalise|RepoDiff|FailedRenders' -count=1` passed (2.735 s wall;
  package runtimes 0.030 s and 0.175 s). Expanded cases cover nested Lists,
  SecretLists, multidocument input, last-applied copies, malformed streams,
  duplicate YAML keys, unsupported mappings, head/base errors and repo diffs.
- `bun test scripts/upgrade-report-sinks_test.ts`: 2 passed, 0 failed, 39 ms.
  Executes the actual workflow revalidation projection with publishing excluded;
  checks malformed-input fallback and the summary/comment/artifact paths.
- Security review found that the first projection copied raw `checks[].name`.
  Before correction, adding a synthetic sentinel to that field failed the sink
  test: the sentinel appeared in `revalidate.json` (1 failed, 1 passed, 25 ms).
  The corrected projection generates fixed check labels and validates every
  retained scalar and check entry before output. A malformed result emits only
  the fixed failure object. After correction and rebase, the same workflow
  projection test passed 2/2 with 48 assertions in 230 ms; the focused Go tests
  passed, Biome passed, and `task verify:text` passed 277/0/1 in 11.559 s.
  The test now executes the actual Markdown and job-summary shell blocks for
  every synthetic case as well: 2/2 tests, 69 assertions, 1.58 s locally.
  Before this correction, the two sink tests took 39 ms. The additional local
  cost is about 1.54 s; the CI job count and dependencies are unchanged.
  Report sinks still publish only the projected JSON and Markdown, never
  `revalidate.raw.json`.
- Initial `task verify:text`: 277 passed, 0 failed, 1 documented preview skip;
  12.598 s wall (10.869 s contract). No chart/configuration change was made.
- No new CI job or dependency is added. The sanitizer adds one traversal per
  parsed object; synthetic package runtime remains below 0.1 s. CI wall-time
  comparison and current-head checks remain to be collected after review/push.
- Delivery child delegation was rejected with `delegation_cycle` through
  MCAA-629; Delivery has been asked for mapping through the existing task thread.

Security rereview of the corrected head, current-head CI evidence, authorized merge and
merged SHA remain outstanding. This document is not a safety verdict or
permission to execute the held report workflow.

The existing `validate` job also fails on the public registry host in
`scripts/localdev-kind.ts:167`. This is present on `main`; independently
reviewable PR #521 carries the guard correction. Its merge and fresh checks
must be confirmed before #511 can be considered green.

On 2026-09-30, #511 integrated both #521 guard commits at `4d72406` on its
isolated branch. The focused guard tests passed, `homelab config guard --set
localdev --ci` scanned 214 files with zero findings, the synthetic sink test
passed 2/2 with 69 assertions, focused upgrade Go tests passed, and level 0
passed 277/0/1 in 17.279 s. This local result does not substitute for the
new-head CI rollup or Security rereview. Delivery's read-only mapping confirms
the held #422 head lacks this fix; a future execution ref cannot be asserted
until the hold is explicitly released.
