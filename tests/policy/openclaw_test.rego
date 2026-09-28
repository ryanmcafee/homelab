package homelab.openclaw

# default_instance is what charts/openclaw renders with its committed values: the
# subscription token and nothing else.
default_instance := {
	"apiVersion": "openclaw.rocks/v1alpha1",
	"kind": "OpenClawInstance",
	"metadata": {"name": "openclaw", "namespace": "openclaw"},
	"spec": {
		"env": [{"name": "ANTHROPIC_OAUTH_TOKEN", "valueFrom": {"secretKeyRef": {
			"name": "openclaw-api-keys",
			"key": "ANTHROPIC_OAUTH_TOKEN",
			"optional": true,
		}}}],
		"config": {"raw": {"models": {"providers": {"anthropic": {"apiKey": "${ANTHROPIC_OAUTH_TOKEN}"}}}}},
	},
}

with_env(entries) := object.union(default_instance, {"spec": object.union(default_instance.spec, {"env": entries})})

credential_ref(name) := {"name": name, "valueFrom": {"secretKeyRef": {
	"name": "openclaw-api-keys",
	"key": name,
	"optional": true,
}}}

test_default_instance_passes if {
	count(deny) == 0 with input as default_instance
}

test_non_instance_ignored if {
	obj := {
		"kind": "Deployment",
		"metadata": {"name": "x", "namespace": "ns"},
		"spec": {"envFrom": [{"secretRef": {"name": "openclaw-api-keys"}}]},
	}
	count(deny) == 0 with input as obj
}

test_envfrom_fails if {
	obj := object.union(default_instance, {"spec": object.union(
		default_instance.spec,
		{"envFrom": [{"secretRef": {"name": "openclaw-api-keys"}}]},
	)})
	some m in deny with input as obj
	startswith(m, "[openclaw-envfrom]")
}

test_claude_code_oauth_token_fails if {
	obj := with_env(array.concat(
		default_instance.spec.env,
		[credential_ref("CLAUDE_CODE_OAUTH_TOKEN")],
	))
	some m in deny with input as obj
	startswith(m, "[openclaw-dead-credential]")
}

# An enabled toggle is legitimate: one extra variable, wired the same way.
test_enabled_anthropic_api_key_passes if {
	obj := with_env(array.concat(
		[credential_ref("ANTHROPIC_API_KEY")],
		default_instance.spec.env,
	))
	count(deny) == 0 with input as obj
}

test_inline_credential_value_fails if {
	obj := with_env(array.concat(
		default_instance.spec.env,
		[{"name": "OPENAI_API_KEY", "value": "sk-literal"}],
	))
	some m in deny with input as obj
	startswith(m, "[openclaw-credential-ref]")
}

test_non_optional_credential_ref_fails if {
	obj := with_env(array.concat(
		default_instance.spec.env,
		[{"name": "OPENAI_API_KEY", "valueFrom": {"secretKeyRef": {
			"name": "openclaw-api-keys",
			"key": "OPENAI_API_KEY",
			"optional": false,
		}}}],
	))
	some m in deny with input as obj
	startswith(m, "[openclaw-credential-ref]")
}

test_mismatched_secret_key_fails if {
	obj := with_env(array.concat(
		default_instance.spec.env,
		[{"name": "OPENAI_API_KEY", "valueFrom": {"secretKeyRef": {
			"name": "openclaw-api-keys",
			"key": "openai",
			"optional": true,
		}}}],
	))
	some m in deny with input as obj
	startswith(m, "[openclaw-credential-ref]")
}

test_provider_pointing_at_unwired_variable_fails if {
	obj := object.union(default_instance, {"spec": object.union(
		default_instance.spec,
		{"config": {"raw": {"models": {"providers": {"openai": {"apiKey": "${OPENAI_API_KEY}"}}}}}},
	)})
	some m in deny with input as obj
	startswith(m, "[openclaw-provider-unwired]")
}

test_provider_without_apikey_passes if {
	obj := object.union(default_instance, {"spec": object.union(
		default_instance.spec,
		{"config": {"raw": {"models": {"providers": {"ollama": {"baseUrl": "http://localhost:11434/v1"}}}}}},
	)})
	count(deny) == 0 with input as obj
}

test_exempt_envfrom if {
	obj := object.union(default_instance, {
		"metadata": {
			"name": "openclaw",
			"namespace": "openclaw",
			"annotations": {
				"homelab.local/policy-exempt": "openclaw-envfrom",
				"homelab.local/policy-exempt-reason": "test fixture",
			},
		},
		"spec": object.union(default_instance.spec, {"envFrom": [{"secretRef": {"name": "openclaw-api-keys"}}]}),
	})
	count(deny) == 0 with input as obj
}

# operator_app(values) is the operator Application carrying `values` as its
# inline helm values string, the shape charts/applications renders.
operator_app(values) := {
	"apiVersion": "argoproj.io/v1alpha1",
	"kind": "Application",
	"metadata": {"name": "openclaw-operator", "namespace": "argocd"},
	"spec": {
		"source": {"chart": "openclaw-operator", "helm": {"values": values}},
		"destination": {"namespace": "openclaw-system"},
	},
}

test_operator_without_watch_namespaces_fails if {
	some m in deny with input as operator_app("crds:\n  install: true\n")
	startswith(m, "[openclaw-operator-scope]")
}

test_operator_with_empty_watch_namespaces_fails if {
	some m in deny with input as operator_app("watchNamespaces: []\n")
	startswith(m, "[openclaw-operator-scope]")
}

# A list holding only blanks is cluster-wide to the chart too: `join ","` on it
# renders --watch-namespaces= , which the manager reads as unset.
test_operator_with_blank_watch_namespace_fails if {
	some m in deny with input as operator_app("watchNamespaces:\n  - \"\"\n")
	startswith(m, "[openclaw-operator-scope]")
}

test_operator_scoped_to_instance_namespace_passes if {
	count(deny) == 0 with input as operator_app("watchNamespaces:\n  - openclaw\n")
}

# The rule keys on the chart name, not on the Application's own name: a
# different upstream chart declaring no watchNamespaces is not this defect.
test_other_chart_application_ignored if {
	obj := object.union(operator_app("crds:\n  install: true\n"), {"spec": {
		"source": {"chart": "cilium", "helm": {"values": "crds:\n  install: true\n"}},
		"destination": {"namespace": "kube-system"},
	}})
	count(deny) == 0 with input as obj
}

routed_instance(gateway) := object.union(default_instance, {"spec": object.union(
	default_instance.spec,
	{"networking": {"httpRoute": {
		"enabled": true,
		"parentRefs": [{"name": gateway, "namespace": "envoy-gateway-system", "sectionName": "https"}],
	}}},
)})

test_instance_routed_to_internal_gateway_fails if {
	some m in deny with input as routed_instance("envoy-internal")
	startswith(m, "[openclaw-shared-route]")
}

# A route the chart renders as disabled keeps its parentRefs in the values but
# never reaches the cluster, so the gateway name alone must not flag.
test_instance_with_disabled_route_passes if {
	obj := object.union(default_instance, {"spec": object.union(
		default_instance.spec,
		{"networking": {"httpRoute": {
			"enabled": false,
			"parentRefs": [{"name": "envoy-internal", "namespace": "envoy-gateway-system"}],
		}}},
	)})
	count(deny) == 0 with input as obj
}

# A dedicated tailnet Gateway is the endpoint this rule is steering toward, so
# it must not be caught by it.
test_instance_routed_to_tailnet_gateway_passes if {
	count(deny) == 0 with input as routed_instance("envoy-tailnet")
}

instance_app(route) := {
	"apiVersion": "argoproj.io/v1alpha1",
	"kind": "Application",
	"metadata": {"name": "openclaw", "namespace": "argocd"},
	"spec": {
		"source": {"path": "charts/openclaw", "helm": {"valuesObject": {"route": route}}},
		"destination": {"namespace": "openclaw"},
	},
}

test_instance_app_routed_to_internal_gateway_fails if {
	route := {"enabled": true, "gateway": {"name": "envoy-internal", "namespace": "envoy-gateway-system"}}
	some m in deny with input as instance_app(route)
	startswith(m, "[openclaw-shared-route]")
}

test_instance_app_with_disabled_route_passes if {
	route := {"enabled": false, "gateway": {"name": "envoy-internal", "namespace": "envoy-gateway-system"}}
	count(deny) == 0 with input as instance_app(route)
}
