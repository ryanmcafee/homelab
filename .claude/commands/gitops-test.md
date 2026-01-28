# GitOps Test Command

Test ArgoCD/GitOps changes by temporarily pointing applications to your feature branch.

## Usage

```
/gitops-test [options]
```

## Arguments

- `$ARGUMENTS` - Optional: specific applications to test (default: all three main apps)

## What This Does

1. **Setup**: Patches `gitops`, `addons`, and `applications` ArgoCD apps to use your current git branch and disables auto-sync
2. **Sync**: Cancels any in-progress syncs, then forces a sync of affected applications
3. **Verify**: Checks sync status and application health
4. **PR**: On success, pushes changes and creates a PR
5. **Fix Loop**: On failure, analyzes errors and helps create fixes
6. **Cleanup**: Restores `targetRevision: main` and re-enables auto-sync

## Prerequisites

- On a git feature branch (not main)
- Branch pushed to origin
- `kubectl` configured with cluster access
- `argocd` CLI authenticated
- `gh` CLI authenticated

## Examples

Test all applications:
```
/gitops-test
```

Test specific application after making addons changes:
```
/gitops-test addons
```

## Execution

When invoked, Claude will:

1. Detect your current branch and verify it's not main
2. Patch ArgoCD applications with the feature branch
3. Wait for you to confirm changes are ready
4. Execute sync and verification loop
5. Guide you through any failures
6. Clean up when testing is complete

## Safety

- Always restores main branch targeting after testing
- Prompts before destructive operations
- Can be safely interrupted (just run cleanup manually)
