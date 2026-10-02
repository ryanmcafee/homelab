# PR dependency triage

`.github/workflows/pr-dependency-triage.yml` labels open pull requests with
`stack/root`, `stack/blocked`, `dependency/orphan`, and `review/ready`. It runs on
`pull_request_target`, hourly, and by manual dispatch. The job uses the base
repository's `GITHUB_TOKEN` with only `pull-requests: write`; it does not check
out or execute pull request code and needs no repository secret.

For a targeted permission check, run:

```sh
gh workflow run pr-dependency-triage.yml --ref <branch> -f pr_number=<open-pr-number>
```

The input limits PR label updates to that one open PR. Before selecting the PR,
the job checks all eight repository label definitions and can create any that
are missing. Omit the input only when you intend to reconcile every open PR.
The job fails if the selected PR is not open or if a label write is denied.
Check the `Classify PR dependency state` log for the changed PR number and the
run's `GITHUB_TOKEN Permissions` section. Dispatch requires Actions write
access for the caller; the workflow token's `pull-requests: write` grant does
not grant the caller that access.

Fork PRs trigger the trusted base-branch workflow. They can receive
`review/ready` when unblocked, but their head branch names are excluded from
parent/child dependency inference. A fork of this repository can run the same
workflow with its own `GITHUB_TOKEN`; no account-specific secret, App, or host
name is needed. The fork must permit Actions and allow the declared token
permission under its repository or organization policy. A policy that caps the
token at read-only makes the label write fail visibly with HTTP 403.
