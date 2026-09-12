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

## Sensitivity

The homelab snapshots are rendered from
`configuration/environments/homelab.yaml.example`. No value from the gitignored
`homelab.yaml` is ever read, so nothing here originates in the real environment
file.

That is not the same as being free of production values. Many child charts still
carry the production domain and IP addresses in their committed
`values-homelab.yaml` files, and a snapshot reproduces whatever its chart's
values say. Removing that PII at the source is tracked in GitHub issue #262.
Until it lands, treat these files as exactly as sensitive as `charts/` already
is.

To see the current extent:

```bash
homelab config guard --ci --paths 'tests/snapshots/**'
```

## Commands

| Command | Purpose |
|---------|---------|
| `homelab verify snapshot` | Diff the current render against the snapshots |
| `homelab verify snapshot --update` | Rewrite the snapshots and delete orphans |
| `homelab verify snapshot --env homelab --chart addons` | Narrow to one env and chart |
| `homelab verify snapshot --json` | Machine-readable result for agents |

A snapshot whose chart no longer renders is reported as an orphan, and
`--update` deletes it. Orphan detection needs the full render, so it is skipped
when `--chart` or `--env` narrows the pass.

## Review discipline

Snapshots are unnormalised: the stored bytes are exactly what `helm template
--include-crds` produced. A chart version bump, a values change or a template
edit will therefore show up as a diff. That diff is the review artifact.

1. Run `homelab verify snapshot` and read the diff in the failing checks.
2. Confirm every changed line is intended.
3. Run `homelab verify snapshot --update` and commit the snapshot change
   alongside the change that caused it.

Never refresh snapshots to make a red check green without reading the diff.
