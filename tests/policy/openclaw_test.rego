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
