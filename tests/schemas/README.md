# Vendored CRD JSON Schemas

This directory holds JSON Schemas for every Kubernetes CustomResourceDefinition (CRD)
this repo renders, converted from the pinned operator charts' own CRD manifests. They
let `kubeconform -strict` validate custom resources completely offline, with no
`-skip` list and no dependency on a public schema catalog (e.g. the datree/CRDs-catalog
mirror used before this existed).

## Layout

```
tests/schemas/
  sources.yaml            # where each CRD group comes from, and which kinds to keep
  <group>/<kind>_<version>.json   # one file per CRD kind x served version
```

kubeconform is pointed at this directory with:

```
-schema-location default \
-schema-location 'tests/schemas/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
```

`{{.ResourceKind}}` and `{{.ResourceAPIVersion}}` are lower-cased by kubeconform, so
filenames are always `lowercase-kind_version.json` (e.g.
`tests/schemas/cilium.io/ciliumloadbalancerippool_v2.json`).

## How it's generated

`scripts/crd-schemas-vendor.ts` (a Deno/TypeScript script — see the repo rule against
Bash/Python scripting) reads `sources.yaml`, resolves each source's chart version from
`configuration/versions.yaml` (`charts.<versionKey>` — **never** hard-coded here), fetches
the upstream CRD manifests, and converts each requested kind's `openAPIV3Schema` into a
standalone draft-07 JSON Schema file.

Two source types are supported:

- **`chart`**: `helm pull --repo <repo> <name> --version <v> --untar`, then
  `helm show crds` (covers CRDs shipped in a chart's special `crds/` directory). If any
  requested kind is still missing, it falls back to
  `helm template --include-crds --kube-version <k8s-version> [...helmArgs]` and pulls out
  every `kind: CustomResourceDefinition` document — this is what's needed for charts that
  template their CRDs under `templates/` gated by a value (cert-manager's
  `crds.enabled`, external-dns's `crd.create`, tailscale-operator's `installCRDs`,
  cloudnative-pg's `crds.create`, argo-cd's ungated `templates/crds/*.yaml`).
- **`github`**: fetches raw CRD YAML files directly from an upstream GitHub repo at a
  ref derived from the pinned chart version (`ref: "v{version}"`, `"argo-workflows-{version}"`,
  etc.), for projects whose Helm chart doesn't ship (or doesn't ship the real, non-minified)
  CRD schemas at all:
  - **cilium**: the `cilium/cilium` Helm chart ships no CRDs whatsoever; the CRDs live in
    the main repo, split across a `v2` and a `v2alpha1` directory.
  - **argo-workflows**: the chart's default values (`crds.full: true`) mean it does
    **not** bundle full-schema CRDs — it downloads them at install time via a
    pre-install Job from `argoproj/argo-helm` at tag `argo-workflows-<chart version>`.
    Vendoring from the packaged chart directly would only yield the "minimal"
    `x-kubernetes-preserve-unknown-fields` CRDs, so this source fetches the same full
    schemas the cluster actually installs.

### Schema conversion rules

For each CRD and each `spec.versions[]` entry:

1. Take `spec.versions[].schema.openAPIV3Schema` as the root.
2. Recursively strip every `x-kubernetes-*` extension key, **except**:
   - `x-kubernetes-preserve-unknown-fields: true` → the enclosing object gets
     `additionalProperties: true`. Without this, kubeconform's `-strict` mode treats an
     object with no `properties` and no explicit `additionalProperties` as closed,
     and rejects any object CRDs deliberately left open (Argo Workflows' `WithItems`,
     ArgoCD's `Application.spec.source.helm.valuesObject`, etc.).
   - `x-kubernetes-int-or-string: true` → if the node doesn't already carry an `anyOf`/
     `oneOf` (Kubernetes structural schemas normally emit `anyOf: [{type: integer},
     {type: string}]` alongside the marker), one is synthesized:
     `oneOf: [{type: "integer"}, {type: "string"}]`.
3. Set the top-level `$schema` to `http://json-schema.org/draft-07/schema#`.
4. Ensure `properties.apiVersion`, `properties.kind` (both `{"type": "string"}`) and
   `properties.metadata` (`{"type": "object"}`) exist, in case an upstream CRD's schema
   omits the envelope fields.
5. Serialize with sorted object keys, 2-space indentation, and a trailing newline, so
   regenerating from an unchanged upstream CRD produces a byte-identical file (stable
   diffs, and a reliable `--check` mode).

## Regenerating

```
task schemas:vendor          # regenerate every source and write tests/schemas/
task schemas:check           # regenerate into a temp dir and fail if anything differs
```

or directly:

```
deno run --allow-net --allow-run --allow-env --allow-read --allow-write \
  scripts/crd-schemas-vendor.ts [--dry-run] [--check] [--only <source-name>]
```

Run `--check` in CI after a Renovate chart-version bump lands: Renovate can't run repo
tasks on its hosted app, so `verify.yml` re-vendors and fails the build with a diff
instruction (which files are `added`, `changed`, or `removed`) until someone runs
`task schemas:vendor` and commits the result.

## Adding a new kind or chart

1. Add (or extend) an entry in `sources.yaml`: `name`, `versionKey` (must match a key
   under `charts:` in `configuration/versions.yaml`), either `chart: {repo, name}` or
   `github: {repo, ref, paths}`, an optional `helmArgs` list (`--set`/`--values` flags
   needed to get the CRD templates to render, e.g. `crds.enabled=true`), and the list of
   `kinds` to vendor.
2. Run `task schemas:vendor` (or the `deno run` invocation above with `--only <name>`
   while iterating).
3. If a requested kind isn't found, the script errors out and lists the kinds it did
   find in that source — use that to fix a typo or confirm the CRD isn't actually
   shipped by the chart (in which case a `github` source may be needed instead).
4. Re-render every chart and confirm `kubeconform -strict` passes with **no** `-skip`
   flag for the new kind.
