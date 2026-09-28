package homelab.workflows_auth

app(helm) := {
	"apiVersion": "argoproj.io/v1alpha1",
	"kind": "Application",
	"metadata": {"name": "renamed-workflows"},
	"spec": {"source": {"chart": "argo-workflows", "helm": helm}},
}

routed(mode) := {"server": {"authMode": mode, "httproute": {"enabled": true}}}

test_unsafe_modes_denied if {
	every mode in ["server", "", null, "none", "no-auth", "sso,server", ["sso", "server"], false] {
		count(deny) == 1 with input as app({"values": yaml.marshal(routed(mode))})
	}
}

test_missing_auth_denied if {
	count(deny) == 1 with input as app({"values": "server:\n  httproute:\n    enabled: true\n"})
}

test_authenticated_controls if {
	every mode in ["sso", "client"] {
		count(deny) == 0 with input as app({"values": yaml.marshal(routed(mode))})
		count(deny) == 0 with input as app({"valuesObject": routed(mode)})
	}
}

test_disabled_route_control if {
	count(deny) == 0 with input as app({"values": "server:\n  authMode: server\n  httproute:\n    enabled: false\n"})
}

test_wrong_source_key_does_not_disable_rendered_route if {
	count(deny) == 1 with input as app({"valuesObject": {"server": {"authMode": "server", "route": {"enabled": false}, "httproute": {"enabled": true}}}})
}

test_values_object_merges_and_overrides if {
	base := {"values": yaml.marshal(routed("sso")), "valuesObject": {"server": {"authMode": "server"}}}
	count(deny) == 1 with input as app(base)
	count(deny) == 0 with input as app({"values": yaml.marshal(routed("server")), "valuesObject": {"server": {"authMode": "sso"}}})
}

test_invalid_values_fail_closed if {
	every raw in ["server: [", "", "null", "[]", "true", false] {
		count(deny) == 1 with input as app({"values": raw})
	}
	count(deny) == 1 with input as app({"valuesObject": null})
}

test_unknown_route_type_fails_closed if {
	every enabled in ["true", "false", null, 1] {
		count(deny) == 1 with input as app({"valuesObject": {"server": {"authMode": "sso", "httproute": {"enabled": enabled}}}})
	}
}

test_uninspected_overrides_denied if {
	every key in ["parameters", "fileParameters", "valueFiles"] {
		helm := object.union({"valuesObject": routed("sso")}, {key: ["override"]})
		count(deny) == 1 with input as app(helm)
	}
}

test_multisource_denied if {
	obj := app({"valuesObject": routed("server")})
	multi := object.union(obj, {"spec": {"source": null, "sources": [obj.spec.source]}})
	count(deny) == 1 with input as multi
}

test_arbitrary_exemption_does_not_bypass if {
	obj := object.union(app({"valuesObject": routed("server")}), {"metadata": {"annotations": {
		"homelab.local/policy-exempt": "workflows-auth",
		"homelab.local/policy-exempt-reason": "approved",
		"homelab.local/workflows-auth-deferred": "true",
	}}})
	count(deny) == 1 with input as obj
}

test_unrelated_chart_ignored if {
	obj := object.union(app({"valuesObject": routed("server")}), {"spec": {"source": {"chart": "other"}}})
	count(deny) == 0 with input as obj
}
