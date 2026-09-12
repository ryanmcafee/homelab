# Golden Snapshots

Byte-for-byte records of every Helm chart rendered for every level-0
environment. `homelab verify snapshot` re-renders the charts and diffs the
output against these files, so an unintended change in rendered Kubernetes
objects fails before anything reaches a cluster.

## Layout

```
tests/snapshots/
├── localdev/<chart>.yaml   # values.yaml + values-localdev.yaml
└── homelab/<chart>.yaml    # values.yaml + config export (two-stage, mirrors the ArgoCD CMP)
```

The homelab snapshots come from `configuration/environments/homelab.yaml.example`,
never from the gitignored `homelab.yaml`, so they contain no PII.

## Commands

| Command | Purpose |
|---------|---------|
| `homelab verify snapshot` | Diff the current render against the snapshots |
| `homelab verify snapshot --update` | Rewrite the snapshots from the current render |
| `homelab verify snapshot --env homelab --chart addons` | Narrow to one env and chart |
| `homelab verify snapshot --json` | Machine-readable result for agents |

## Review discipline

Snapshots are unnormalised: the stored bytes are exactly what `helm template
--include-crds` produced. A chart version bump, a values change or a template
edit will therefore show up as a diff. That diff is the review artifact.

1. Run `homelab verify snapshot` and read the diff in the failing checks.
2. Confirm every changed line is intended.
3. Run `homelab verify snapshot --update` and commit the snapshot change
   alongside the change that caused it.

Never refresh snapshots to make a red check green without reading the diff.
