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

# All three chart inputs append flags; none overrides an earlier mode.
# Keep extraArgs deliberately narrow: auth flags and unrelated --flag=value
# tokens only. Positional arguments, terminators and unknown split forms could
# change how later flags are parsed, so they must fail closed.
allowed_modes := {"sso", "client"}

safe_arg(args, i) if {
	args[i] in {"--auth-mode=sso", "--auth-mode=client"}
}

safe_arg(args, i) if {
	args[i] == "--auth-mode"
	args[i + 1] in allowed_modes
}

safe_arg(args, i) if {
	i > 0
	args[i - 1] == "--auth-mode"
	args[i] in allowed_modes
}

safe_arg(args, i) if {
	regex.match("^--[a-zA-Z0-9][a-zA-Z0-9-]*=\\S+$", args[i])
	not startswith(lower(args[i]), "--auth-mode=")
}

safe(values) if {
	object.get(values, ["server", "httproute", "enabled"], false) == true
	server := object.get(values, "server", {})
	singular := object.get(server, "authMode", "")
	singular in {"", "sso", "client"}
	plural := object.get(server, "authModes", [])
	is_array(plural)
	every mode in plural {
		mode in allowed_modes
	}
	args := object.get(server, "extraArgs", [])
	is_array(args)
	every i, arg in args {
		is_string(arg)
		safe_arg(args, i)
	}

	# At least one explicit mode is required; never trust chart/server defaults.
	modes := ({mode | mode := plural[_]} | {singular | singular in allowed_modes}) | {mode | some arg in args; mode := trim_prefix(arg, "--auth-mode="); mode in allowed_modes}
	count(modes) > 0
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
	msg := sprintf("[workflows-auth] %s: routed Workflows requires a non-empty effective auth mode set containing only sso/client across server.authMode, server.authModes and server.extraArgs; server/hybrid, malformed lists and ambiguous arguments are forbidden. Use authModes: [client] and canonical --auth-mode=client/--auth-mode=sso (split --auth-mode, client is also supported); unrelated extraArgs must use --flag=value without whitespace; auth-mode spelling must be lowercase. Set server.httproute.enabled=false to disable exposure (source: server.route.enabled). Any deferral requires a separately recorded Architect review and policy change", [lib.id(input)])
}
