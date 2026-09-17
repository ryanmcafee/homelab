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
