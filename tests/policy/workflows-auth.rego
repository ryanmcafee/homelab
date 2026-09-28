package homelab.workflows_auth

import data.homelab.lib

# Inspect the remote chart's rendered values, not the parent's server.route.
# A renamed Application or a multi-source Application still gets checked.
sources contains source if {
	input.apiVersion == "argoproj.io/v1alpha1"
	input.kind == "Application"
	source := input.spec.source
	source.chart == "argo-workflows"
}

sources contains source if {
	input.apiVersion == "argoproj.io/v1alpha1"
	input.kind == "Application"
	some source in input.spec.sources
	source.chart == "argo-workflows"
}

# Invalid YAML / unexpected types must not make the deny rule undefined.
# Mixed representations are rejected below rather than assuming precedence.
values(helm) := merged if {
	raw := object.get(helm, "values", "{}")
	is_string(raw)
	parsed := yaml.unmarshal(raw)
	is_object(parsed)
	obj := object.get(helm, "valuesObject", {})
	is_object(obj)
	merged := object.union(parsed, obj)
}

mixed_values(helm) if {
	"values" in object.keys(helm)
	"valuesObject" in object.keys(helm)
}

inspectable(helm) if {
	not mixed_values(helm)
	is_object(values(helm))
	# External files and --set overrides cannot be verified from inline values.
	count(object.get(helm, "valueFiles", [])) == 0
	count(object.get(helm, "fileParameters", [])) == 0
	count(object.get(helm, "parameters", [])) == 0
}

safe(values) if {
	object.get(values, ["server", "httproute", "enabled"], false) == false
}

safe(values) if {
	object.get(values, ["server", "httproute", "enabled"], false) == true
	object.get(values, ["server", "authMode"], "") in {"sso", "client"}
}

# Deliberately does NOT call lib.is_exempt: a boolean or arbitrary reason is
# not an Architect-reviewed recorded deferral. No deferrals are authorized.
deny contains msg if {
	some source in sources
	helm := object.get(source, "helm", {})
	not inspectable(helm)
	msg := sprintf("[workflows-auth] %s: cannot verify Workflows authentication; use exactly one valid inline Helm values or valuesObject representation without valueFiles, parameters or fileParameters", [lib.id(input)])
}

deny contains msg if {
	some source in sources
	helm := object.get(source, "helm", {})
	inspectable(helm)
	not safe(values(helm))
	msg := sprintf("[workflows-auth] %s: routed Workflows requires explicit server.authMode sso or client; server/no-auth, missing or empty auth is forbidden. Set server.httproute.enabled=false to disable exposure (source: server.route.enabled). Any deferral requires a separately recorded Architect review and policy change", [lib.id(input)])
}
