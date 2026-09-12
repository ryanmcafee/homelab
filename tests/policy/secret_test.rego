package homelab.secret

test_repo_secret_pass if {
	obj := {
		"kind": "Secret",
		"metadata": {"name": "truecharts-oci", "namespace": "argocd"},
		"stringData": {"name": "truecharts", "type": "helm", "url": "oci.trueforge.org/truecharts", "enableOCI": "true"},
	}
	count(deny) == 0 with input as obj
}

test_non_secret_ignored if {
	obj := {"kind": "ConfigMap", "metadata": {"name": "x", "namespace": "ns"}, "data": {"password": "x"}}
	count(deny) == 0 with input as obj
}

test_inline_secret_fails if {
	obj := {
		"kind": "Secret",
		"metadata": {"name": "leaky", "namespace": "default"},
		"data": {"password": "cGFzc3dvcmQ="},
	}
	some m in deny with input as obj
	startswith(m, "[inline-secret]")
}

test_inline_secret_via_string_data_fails if {
	obj := {
		"kind": "Secret",
		"metadata": {"name": "leaky", "namespace": "default"},
		"stringData": {"api-token": "supersecret"},
	}
	some m in deny with input as obj
	startswith(m, "[inline-secret]")
}

test_exempt_inline_secret if {
	obj := {
		"kind": "Secret",
		"metadata": {"name": "leaky", "namespace": "default", "annotations": {
			"homelab.ryanmcafee.com/policy-exempt": "inline-secret",
			"homelab.ryanmcafee.com/policy-exempt-reason": "test fixture",
		}},
		"data": {"password": "cGFzc3dvcmQ="},
	}
	count(deny) == 0 with input as obj
}
