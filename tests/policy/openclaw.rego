package homelab.openclaw

import data.homelab.lib

# Credential wiring rules for openclaw.rocks OpenClawInstance objects
# (docs/apps/openclaw.md). The point of these rules is what they forbid: a
# rendered Instance that merely boots proves nothing about which provider is
# paying for the agent's tokens.

# metered_env are the variables that move spend to per-token API billing. None of
# them may appear unless the matching charts/openclaw adapters.apiKeys toggle put
# it there, which is why each one is listed here by name rather than inferred.
metered_env := {"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"}

# subscription_env is the variable OpenClaw reads a `claude setup-token`
# credential from (extensions/anthropic/provider-contract-api.ts). It ranks above
# ANTHROPIC_API_KEY in OpenClaw, the opposite of Claude Code's own order.
subscription_env := "ANTHROPIC_OAUTH_TOKEN"

# dead_env are variables that look like working auth and are not. OpenClaw lists
# CLAUDE_CODE_OAUTH_TOKEN in CLAUDE_CLI_CLEAR_ENV and strips it before every
# managed Claude CLI run, so an Instance carrying it has no subscription auth at
# all while reading as though it does. charts/paperclip legitimately uses that
# name; an OpenClawInstance must not.
dead_env := {"CLAUDE_CODE_OAUTH_TOKEN"}

is_instance if {
	input.kind == "OpenClawInstance"
}

is_application if {
	input.kind == "Application"
	input.apiVersion == "argoproj.io/v1alpha1"
}

# The operator Application carries the signed chart's values; the instance
# Application carries charts/openclaw's.
is_operator_app if {
	is_application
	object.get(object.get(input.spec, "source", {}), "chart", "") == "openclaw-operator"
}

is_instance_app if {
	is_application
	object.get(object.get(input.spec, "source", {}), "path", "") == "charts/openclaw"
}

# watched_namespaces are the namespaces the operator chart confines the
# controller to. A non-array or absent value falls back to the empty set, which
# is exactly what the chart treats as cluster-wide.
default watched_namespaces := set()

watched_namespaces := {ns |
	some ns in object.get(lib.inline_values(input), "watchNamespaces", [])
	is_string(ns)
	trim_space(ns) != ""
}

# openclaw-operator-scope: openclaw-operator renders a ClusterRole granting
# Secret get/list/watch/create/update/patch whenever watchNamespaces is empty
# (templates/rbac.yaml). Naming the instance namespace downgrades that to a Role
# there plus a read-only Secret Role in the operator's own namespace, so a
# compromised controller cannot reach credentials in unrelated namespaces.
deny contains msg if {
	is_operator_app
	not lib.is_exempt(input, "openclaw-operator-scope")
	count(watched_namespaces) == 0
	msg := sprintf("[openclaw-operator-scope] %s: inline values declare no watchNamespaces, so the controller watches every namespace and its Secret access is bound cluster-wide; name the OpenClawInstance namespace", [lib.id(input)])
}

env_entries := object.get(input, ["spec", "env"], [])

env_names := {name |
	some entry in env_entries
	name := entry.name
}

# openclaw-envfrom: referencing a Secret as a whole exposes every key it holds at
# once. The upstream samples do exactly that; this repo names each key instead so
# a provider credential nobody enabled cannot ride along.
deny contains msg if {
	is_instance
	not lib.is_exempt(input, "openclaw-envfrom")
	count(object.get(input, ["spec", "envFrom"], [])) > 0
	msg := sprintf("[openclaw-envfrom] %s: spec.envFrom exposes every key of the referenced Secret; declare each credential under spec.env instead", [lib.id(input)])
}

# openclaw-dead-credential: a variable OpenClaw discards.
deny contains msg if {
	is_instance
	not lib.is_exempt(input, "openclaw-dead-credential")
	some name in env_names
	name in dead_env
	msg := sprintf("[openclaw-dead-credential] %s: %s is stripped by OpenClaw before every managed Claude CLI run; the subscription token belongs in %s", [lib.id(input), name, subscription_env])
}

# openclaw-credential-ref: a credential must come from the credentials Secret by
# reference, keyed by its own name, and optional so a Secret that does not carry
# it leaves the variable unset instead of blocking the pod.
deny contains msg if {
	is_instance
	not lib.is_exempt(input, "openclaw-credential-ref")
	some entry in env_entries
	credential_name(entry.name)
	not valid_credential_ref(entry)
	msg := sprintf("[openclaw-credential-ref] %s: env %s must be an optional secretKeyRef whose key equals the variable name", [lib.id(input), entry.name])
}

credential_name(name) if {
	name in metered_env
}

credential_name(name) if {
	name == subscription_env
}

valid_credential_ref(entry) if {
	ref := entry.valueFrom.secretKeyRef
	ref.key == entry.name
	ref.optional == true
	object.get(ref, "name", "") != ""
}

# openclaw-provider-unwired: every config.models.providers entry interpolates a
# variable; that variable has to be one the Instance actually declares. Under
# config.forcePaths this block is the complete provider allowlist, so an entry
# pointing at an unset variable is a provider that silently cannot authenticate.
deny contains msg if {
	is_instance
	not lib.is_exempt(input, "openclaw-provider-unwired")
	providers := object.get(input, ["spec", "config", "raw", "models", "providers"], {})
	some provider, config in providers
	some referenced in interpolated(object.get(config, "apiKey", ""))
	not referenced in env_names
	msg := sprintf("[openclaw-provider-unwired] %s: provider %s reads ${%s}, which is not declared under spec.env", [lib.id(input), provider, referenced])
}

# interpolated returns the variable names a config value refers to as ${NAME}.
interpolated(value) := {name |
	some match in regex.find_all_string_submatch_n(`\$\{([A-Z0-9_]+)\}`, value, -1)
	name := match[1]
}

# openclaw-shared-route: the internal Gateway is provisioned for the LAN as well
# as the tailnet (configuration/templates/helm-addons.tmpl gateways.internal), so
# a route on it puts the Control UI in front of every LAN client behind the
# gateway bearer token alone. docs/apps/openclaw.md records the requirement as
# tailnet-only; that needs its own endpoint, not this shared one.
deny contains msg if {
	is_instance
	not lib.is_exempt(input, "openclaw-shared-route")
	route := object.get(input, ["spec", "networking", "httpRoute"], {})
	object.get(route, "enabled", false) == true
	some ref in object.get(route, "parentRefs", [])
	object.get(ref, "name", "") == lib.gateway_internal
	msg := sprintf("[openclaw-shared-route] %s: httpRoute attaches to the shared %s Gateway, which serves the LAN as well as the tailnet; OpenClaw's exposure requirement is tailnet-only", [lib.id(input), lib.gateway_internal])
}

# The same contract one level up, where re-enabling it would actually be typed
# (configuration/templates/helm-apps.tmpl openclaw.instance.route).
deny contains msg if {
	is_instance_app
	not lib.is_exempt(input, "openclaw-shared-route")
	route := object.get(lib.inline_values(input), "route", {})
	object.get(route, "enabled", false) == true
	object.get(object.get(route, "gateway", {}), "name", "") == lib.gateway_internal
	msg := sprintf("[openclaw-shared-route] %s: inline values route.enabled attaches to the shared %s Gateway, which serves the LAN as well as the tailnet; OpenClaw's exposure requirement is tailnet-only", [lib.id(input), lib.gateway_internal])
}
