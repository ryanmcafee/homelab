# ArgoCD health Lua fixtures

Fixtures for the resource health scripts in `charts/bootstrap/files/health/`.
Each `<group>_<kind>.lua` there is what ArgoCD runs to decide whether a
resource of that kind is Healthy, Progressing, Degraded or Suspended. The
bootstrap chart injects every file into `argocd-cm` as
`resource.customizations.health.<group>_<kind>`; localdev passes the same files
to the ArgoCD chart with `--set-file`.

## Quick start

```bash
task test:health                                   # every script, every fixture
task test:health -- --only tailscale.com_Connector # one script
```

The runner (`scripts/health-test.ts`) evaluates each fixture with
`argocd admin settings resource-overrides health` against a temporary
`argocd-cm` built from the Lua files, so what passes here is exactly what the
controller computes. It needs the pinned `argocd` CLI from `mise.toml`.

## Layout

```
tests/health/<group>_<kind>/<name>.yaml
```

The directory name must equal the Lua file name minus `.lua`, and the fixture's
own `apiVersion`/`kind` must resolve to the same `<group>_<kind>` (a fixture in
the wrong directory fails instead of silently exercising a different script).
Every script needs at least one fixture and every directory needs a script.

## Fixture format

```yaml
# expect: Degraded
# message: item not found
apiVersion: onepassword.com/v1
kind: OnePasswordItem
metadata:
  name: truenas-api-key
  namespace: democratic-csi
status:
  conditions:
    - type: Ready
      status: "False"
      message: "Failed to retrieve item: item not found"
```

- Line 1, required: `# expect: Healthy|Progressing|Degraded|Suspended`.
- Line 2, optional: `# message: <substring>` the returned message must contain.
- The rest is a stripped-down but realistic object: `apiVersion`, `kind`,
  `metadata`, and whatever `spec`/`status` the script inspects. Keep hostnames
  under `homelab.local` and use documentation IPs; nothing here is production.

## Adding a health check

1. Create `charts/bootstrap/files/health/<group>_<kind>.lua` (`hs.status`,
   `hs.message`, `return hs`; guard every nil, and remember `""` is truthy in
   Lua so `condition.message or "fallback"` does not fall back).
2. Add `tests/health/<group>_<kind>/` with at least a `healthy.yaml`, plus a
   `progressing.yaml` and `degraded.yaml` when the script can return them.
3. `task test:health`, then `task verify:text -- --chart bootstrap` and
   `task test:snapshot -- --update` (the rendered `argocd-cm` changes).
