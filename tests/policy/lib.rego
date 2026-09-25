package homelab.lib

# domain is the base domain for the environment under test, supplied via
# `conftest test --data <renderDir>/<env>/_data.yaml` (level 0) or
# `--data tests/policy/negative/_data.yaml` (fixtures). A single YAML/JSON
# file passed to --data is flattened: its top-level keys land directly under
# data, so a file containing `domain: example.com` exposes data.domain.
domain := data.domain

# automated_sync_required reports whether every Application must carry
# syncPolicy.automated (app-automated). The renderer writes
# `argocd_automated_sync: <bool>` into _data.yaml from the env's
# ARGOCD_AUTOMATED_SYNC platform key; localdev sets it false because its
# Applications are synced from the working tree with `argocd app sync
# --local`, which an automated Application would immediately revert. Absent
# key (older _data.yaml, fixture data) keeps the strict policy.
default automated_sync_required := true

automated_sync_required := false if {
	data.argocd_automated_sync == false
}

# exempt_rules returns the set of rule ids an object is exempt from, read
# from the annotations:
#
#   homelab.local/policy-exempt: "<rule-id>[,<rule-id>...]"
#   homelab.local/policy-exempt-reason: "<why>"
#
# Both annotations are required: an exempt annotation without a reason grants
# no exemption at all.
default exempt_rules(obj) := set()

exempt_rules(obj) := rules if {
	ann := object.get(object.get(obj, "metadata", {}), "annotations", {})
	raw := object.get(ann, "homelab.local/policy-exempt", "")
	raw != ""
	reason := object.get(ann, "homelab.local/policy-exempt-reason", "")
	reason != ""
	rules := {trim_space(r) | some r in split(raw, ",")}
}

# is_exempt reports whether obj carries a valid exemption for rule.
is_exempt(obj, rule) if {
	rule in exempt_rules(obj)
}

# id renders a stable "Kind/namespace/name" identifier for deny messages,
# matching internal/verify.Doc.ID(). Every lookup is defensive (object.get)
# so a malformed object still produces a usable identifier instead of making
# the whole rule undefined.
id(obj) := sprintf("%s/%s/%s", [
	object.get(obj, "kind", "?"),
	object.get(object.get(obj, "metadata", {}), "namespace", ""),
	object.get(object.get(obj, "metadata", {}), "name", ""),
])

# gateway_namespace / gateway_internal / gateway_external name the Envoy
# Gateways every HTTPRoute must attach to. The renderer writes them into
# _data.yaml from GATEWAY_NAMESPACE / GATEWAY_INTERNAL / GATEWAY_EXTERNAL; the
# defaults match configuration/environments/defaults.yaml.
default gateway_namespace := "envoy-gateway-system"

gateway_namespace := data.gateway_namespace if is_string(data.gateway_namespace)

default gateway_internal := "envoy-internal"

gateway_internal := data.gateway_internal if is_string(data.gateway_internal)

default gateway_external := "envoy-external"

gateway_external := data.gateway_external if is_string(data.gateway_external)

# inline_values parses an Application's inline helm values: the
# spec.source.helm.values YAML string merged with helm.valuesObject.
default helm_values_string(helm) := {}

helm_values_string(helm) := yaml.unmarshal(helm.values) if is_string(helm.values)

default helm_values_object(helm) := {}

helm_values_object(helm) := helm.valuesObject if is_object(helm.valuesObject)

default inline_values(obj) := {}

inline_values(obj) := merged if {
	helm := object.get(object.get(obj.spec, "source", {}), "helm", {})
	merged := object.union(helm_values_string(helm), helm_values_object(helm))
}
