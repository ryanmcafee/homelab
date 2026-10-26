# Upgrade report safety boundary

MCAA-652: upstream and repository report diffs share `normaliseDocs` in
`internal/verify/upgrade.go`. Redact Secret fields before building diff strings;
Markdown-only redaction leaves JSON findings exposed. Lists require recursive
handling and SecretList items can omit kind. Parser/Helm errors and revalidation
findings can echo payloads, so report errors use fixed diagnostics. Workflow
artifact paths must never include raw JSON or `--keep` render directories.
Redacted equality cannot prove payload equality and must not open automerge.

Tests: `go test ./internal/verify -run 'TestUpgrade(ReportSecret|Redaction|ErrorReports|RepoReports)'`
and `bun test scripts/upgrade-report-sinks_test.ts`. All fixtures are synthetic,
offline and nonpublishing. PR #422 remains held pending explicit leadership release.
