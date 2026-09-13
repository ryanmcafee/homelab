## Summary

<!-- What changed and why. Link the issue (Closes #N). -->

-

## Verification

<!--
Run `task verify:claim` on the PR head and replace the block below (the
verify-level0 marker line and the fenced JSON) with its output. CI
(.github/workflows/pr-contract.yml) re-runs level 0 on the same head and fails
when the claim is missing or disagrees: same check names, no pass/fail
difference, same overall result. Refresh the block after a push that changes
the result. Details: docs/runbooks/verification.md, section "Agent contract".
-->

<!-- verify-level0 -->
```json
replace this block with the output of: task verify:claim
```

- [ ] Kind: `task localdev:up && task verify:text LEVEL=2` (charts changed; `tilt-ci.yml` re-runs it)
- [ ] Preview: `preview` + `preview:<app>` labels (optional, application changes; docs/runbooks/previews.md)

## Test plan

- [ ]
