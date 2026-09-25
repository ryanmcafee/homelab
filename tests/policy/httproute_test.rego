package homelab.httproute

route(name, namespace, refs) := {
	"apiVersion": "gateway.networking.k8s.io/v1",
	"kind": "HTTPRoute",
	"metadata": {"name": name, "namespace": namespace},
	"spec": {
		"parentRefs": refs,
		"hostnames": ["app.example.com"],
		"rules": [{"backendRefs": [{"name": name, "port": 80}]}],
	},
}

ref(name, namespace, section) := {"name": name, "namespace": namespace, "sectionName": section}

test_internal_https_passes if {
	count(deny) == 0 with input as route("sonarr", "sonarr", [ref("envoy-internal", "envoy-gateway-system", "https")])
}

test_external_https_passes if {
	count(deny) == 0 with input as route("plex", "plex", [ref("envoy-external", "envoy-gateway-system", "https")])
}

test_gateway_names_come_from_data if {
	obj := route("app", "app", [ref("gw-a", "gateways", "https")])
	count(deny) == 0 with input as obj
		with data.gateway_namespace as "gateways"
		with data.gateway_internal as "gw-a"
		with data.gateway_external as "gw-b"
}

test_missing_section_name_is_denied if {
	obj := route("app", "app", [{"name": "envoy-internal", "namespace": "envoy-gateway-system"}])
	some m in deny with input as obj
	startswith(m, "[httproute-parent]")
}

test_http_listener_with_backend_is_denied if {
	some m in deny with input as route("app", "app", [ref("envoy-internal", "envoy-gateway-system", "http")])
	startswith(m, "[httproute-parent]")
}

test_missing_namespace_defaults_to_route_namespace if {
	obj := route("app", "app", [{"name": "envoy-internal", "sectionName": "https"}])
	some m in deny with input as obj
	contains(m, "app/envoy-internal")
}

test_unknown_gateway_is_denied if {
	some m in deny with input as route("app", "app", [ref("nginx", "envoy-gateway-system", "https")])
	startswith(m, "[httproute-parent]")
}

test_no_parent_refs_is_denied if {
	some m in deny with input as route("app", "app", [])
	contains(m, "no parentRefs")
}

test_non_gateway_parent_is_denied if {
	obj := route("app", "app", [{"kind": "Service", "group": "", "name": "envoy-internal", "namespace": "envoy-gateway-system", "sectionName": "https"}])
	some m in deny with input as obj
	startswith(m, "[httproute-parent]")
}

test_redirect_route_on_http_listener_passes if {
	obj := {
		"kind": "HTTPRoute",
		"metadata": {"name": "envoy-internal-https-redirect", "namespace": "envoy-gateway-system"},
		"spec": {
			"parentRefs": [{"name": "envoy-internal", "sectionName": "http"}],
			"rules": [{"filters": [{"type": "RequestRedirect", "requestRedirect": {"scheme": "https", "statusCode": 301}}]}],
		},
	}
	count(deny) == 0 with input as obj
}

test_echo_on_istio_gateway_passes if {
	obj := route("echo", "istio-ingress", [
		ref("envoy-internal", "envoy-gateway-system", "https"),
		{"name": "istio-internal", "sectionName": "https"},
	])
	count(deny) == 0 with input as obj
}

test_other_route_on_istio_gateway_is_denied if {
	obj := route("sonarr", "istio-ingress", [{"name": "istio-internal", "sectionName": "https"}])
	some m in deny with input as obj
	startswith(m, "[httproute-parent]")
}

test_exempt_route_passes if {
	obj := object.union(route("app", "app", [ref("nginx", "x", "web")]), {"metadata": {
		"name": "app",
		"namespace": "app",
		"annotations": {
			"homelab.local/policy-exempt": "httproute-parent",
			"homelab.local/policy-exempt-reason": "test fixture",
		},
	}})
	count(deny) == 0 with input as obj
}

application(values) := {
	"apiVersion": "argoproj.io/v1alpha1",
	"kind": "Application",
	"metadata": {"name": "app", "namespace": "argocd"},
	"spec": {"source": {"helm": {"values": values}}},
}

test_inline_parent_refs_pass if {
	values := "route:\n  main:\n    enabled: true\n    parentRefs:\n      - name: envoy-internal\n        namespace: envoy-gateway-system\n        sectionName: https\n"
	count(deny) == 0 with input as application(values)
}

test_inline_parent_refs_without_section_are_denied if {
	values := "route:\n  main:\n    parentRefs:\n      - name: envoy-internal\n        namespace: envoy-gateway-system\n"
	some m in deny with input as application(values)
	contains(m, "route.main.parentRefs")
}

test_inline_parent_refs_without_namespace_are_denied if {
	values := "route:\n  main:\n    parentRefs:\n      - name: envoy-internal\n        sectionName: https\n"
	some m in deny with input as application(values)
	startswith(m, "[httproute-parent]")
}

test_inline_http_listener_is_denied if {
	values := "route:\n  parentRefs:\n    - name: envoy-external\n      namespace: envoy-gateway-system\n      sectionName: http\n"
	some m in deny with input as application(values)
	startswith(m, "[httproute-parent]")
}

test_inline_parent_refs_in_values_object_are_checked if {
	obj := {
		"apiVersion": "argoproj.io/v1alpha1",
		"kind": "Application",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"valuesObject": {"httpRoute": {"parentRefs": [{"name": "envoy-internal", "namespace": "wrong"}]}}}}},
	}
	some m in deny with input as obj
	startswith(m, "[httproute-parent]")
}

test_ingress_is_denied if {
	obj := {"apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": {"name": "x", "namespace": "ns"}}
	some m in deny with input as obj
	startswith(m, "[no-ingress]")
}

test_inline_ingress_enabled_is_denied if {
	some m in deny with input as application("server:\n  ingress:\n    enabled: true\n")
	contains(m, "server.ingress.enabled")
}

test_inline_truecharts_ingress_enabled_is_denied if {
	some m in deny with input as application("ingress:\n  main:\n    enabled: true\n")
	startswith(m, "[no-ingress]")
}

test_inline_ingress_disabled_passes if {
	count(deny) == 0 with input as application("ingress:\n  enabled: false\n")
}

test_inline_network_policy_ingress_passes if {
	count(deny) == 0 with input as application("networkPolicy:\n  ingress:\n    enabled: true\n")
}
