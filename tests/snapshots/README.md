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

Nor do the snapshots contain production values from the charts themselves.
Child charts keep only non-derived settings in their committed
`values-homelab.yaml`; the domain, hostnames, IPs, iSCSI portal and e-mail they
need arrive through the parent Application's `helm.valuesObject` (ADR-010). The
render mirrors that: parents render first, and each child receives the
`valuesObject` extracted from its parent as an extra values file, written to
`_inherited/<chart>.yaml` in the render directory. So a homelab snapshot only
ever shows the `REPLACEME-*` / `192.168.1.x` placeholders from the example file.

`homelab config guard` scans `configuration/**` and `charts/**/values-homelab.yaml`
by default. To confirm the snapshots stayed clean after a chart change:

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
