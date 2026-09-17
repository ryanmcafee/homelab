# CI autofix

`.github/workflows/ci-autofix.yml` watches every pull-request workflow. When one fails, Claude
Code triages the failure from the run's own logs and, when the cause is in this repository,
fixes it, proves the fix with the same check locally, pushes a commit to the PR branch and waits
for CI on the new head. The outcome lands in the sticky PR comment `ci-autofix`.

## What it will and won't do

| Failure | Action |
|---|---|
| Formatting (`deno fmt`, gofmt, terraform fmt), lint findings | fix, run the linter, push |
| Golden snapshot drift | `task test:snapshot -- --update`, push |
| Stale localdev values, CRD schemas, doc numbers | `task config:export:localdev`, `task schemas:vendor`, `task docs:check -- --fix`, push |
| A unit, policy or health test the PR broke | fix the code or the test the PR added, run it, push |
| Level-0 claim mismatch (`PR contract`) | re-run `task verify:claim`, update the PR body |
| Runner lost, checkout/install failure, registry timeout before any test ran | re-run the failed jobs once, push nothing |
| Kind loop (levels 1-2) failures | fix what the log proves, push; the re-run is the verification (no Kind here) |
| Needs a design decision, credentials, hardware, or the check itself would have to be weakened | comment with the diagnosis and a proposed patch, push nothing |

Never: skip, disable or quarantine a test; edit a workflow to pass; hand-edit `tests/snapshots/`;
change `configuration/versions.yaml` unless the failing check is the version-drift check; force-push,
rebase or amend; commit a real address; add AI attribution to commits or the PR body.

## Guardrails

- Same-repo pull requests only; `renovate/*` branches are excluded (Renovate abandons a branch
  with foreign commits; `upgrade.yml`'s regeneration bot owns those).
- At most `MAX_ATTEMPTS` (2) bot commits per PR, counted by the bot's author e-mail since the
  merge base; after that the workflow stands down and says so.
- Stands down when the branch already moved past the failed commit.
- Label a PR `no-autofix` to opt it out.
- The job never fails on its own account: a red verification is reported in the comment, so the
  original failure stays the visible one.
- The push uses the homelab bot App token so the fix triggers CI; `GITHUB_TOKEN` stays read-only.

## Secrets

| Secret | Purpose |
|---|---|
| `HOMELAB_BOT_APP_ID`, `HOMELAB_BOT_PRIVATE_KEY` | the GitHub App `upgrade.yml` already uses; needs `contents: write`, `pull-requests: write`, `actions: read` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code subscription token (`claude setup-token`); `ANTHROPIC_API_KEY` works instead |

Without either pair the job logs a notice and exits green.

## Reading a run

The sticky comment has three parts: the triage verdict (`fixed`, `rerun` or `manual`), what
changed or the proposed patch, and the verification (`CI is green on <sha>`, the list of checks
still red, or a timeout after `VERIFY_TIMEOUT_MINUTES`). The bot's commits are
`fix(ci): …` with a `Ci-Autofix-Run: <run id>` trailer, so `git log --grep Ci-Autofix-Run`
lists everything it ever pushed.

## Disabling

Delete the secrets, add `no-autofix` to a PR, or remove a workflow name from the `workflows:`
list in `ci-autofix.yml` to stop reacting to it.
