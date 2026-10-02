package homelab.hostname

test_httproute_pass if {
	obj := {"kind": "HTTPRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"hostnames": ["app.example.com"]}}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_httproute_fail if {
	obj := {"kind": "HTTPRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"hostnames": ["app.example.com", "app.other.com"]}}
	msgs := {m | some m in deny} with input as obj with data.domain as "example.com"
	count(msgs) == 1
	some m in msgs
	contains(m, "app.other.com")
}

test_httproute_lookalike_suffix_fails if {
	obj := {"kind": "HTTPRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"hostnames": ["app.notexample.com"]}}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_gateway_wildcard_listener_pass if {
	obj := {"kind": "Gateway", "metadata": {"name": "envoy-internal", "namespace": "envoy-gateway-system"}, "spec": {"listeners": [
		{"name": "http", "port": 80},
		{"name": "https", "port": 443, "hostname": "*.example.com"},
	]}}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_gateway_listener_fail if {
	obj := {"kind": "Gateway", "metadata": {"name": "envoy-internal", "namespace": "envoy-gateway-system"}, "spec": {"listeners": [{"name": "https", "hostname": "*.other.com"}]}}
	some m in deny with input as obj with data.domain as "example.com"
	contains(m, "*.other.com")
}

test_certificate_apex_and_wildcard_pass if {
	obj := {"kind": "Certificate", "metadata": {"name": "gateway-wildcard-tls", "namespace": "envoy-gateway-system"}, "spec": {"dnsNames": ["example.com", "*.example.com"]}}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_certificate_pass if {
	obj := {"kind": "Certificate", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"dnsNames": ["auth.example.com"]}}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_certificate_fail if {
	obj := {"kind": "Certificate", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"dnsNames": ["auth.other.com"]}}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_dnsendpoint_pass if {
	obj := {"kind": "DNSEndpoint", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"endpoints": [{"dnsName": "gateway.example.com", "recordType": "A"}]}}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_dnsendpoint_fail if {
	obj := {"kind": "DNSEndpoint", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"endpoints": [{"dnsName": "gateway.other.com", "recordType": "A"}]}}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_exempt_hostname if {
	obj := {
		"kind": "HTTPRoute",
		"metadata": {"name": "x", "namespace": "ns", "annotations": {
			"homelab.local/policy-exempt": "hostname-domain",
			"homelab.local/policy-exempt-reason": "test fixture",
		}},
		"spec": {"hostnames": ["app.other.com"]},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

# --- domain-missing safety net ---------------------------------------------

test_domain_missing_fires_for_httproute if {
	obj := {"kind": "HTTPRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"hostnames": ["app.example.com"]}}
	msgs := {m | some m in deny} with input as obj with data.domain as ""
	msgs == {"[hostname-domain] policy data missing domain"}
}

test_domain_undefined_fires_for_certificate if {
	obj := {"kind": "Certificate", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"dnsNames": ["auth.example.com"]}}
	msgs := {m | some m in deny} with input as obj with data.domain as null
	msgs == {"[hostname-domain] policy data missing domain"}
}

test_domain_missing_does_not_spam_unrelated_kinds if {
	obj := {"kind": "ConfigMap", "metadata": {"name": "x", "namespace": "ns"}, "data": {"host": "whatever"}}
	count(deny) == 0 with input as obj with data.domain as ""
}

# --- inline helm values on Applications ------------------------------------

test_inline_route_hostnames_pass if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "sonarr", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "route:\n  main:\n    hostnames:\n      - sonarr.example.com\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_route_hostnames_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "sonarr", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "route:\n  main:\n    hostnames:\n      - sonarr.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_host_key_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "route:\n  host: app.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_hosts_list_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "route:\n  hosts:\n    - app.example.com\n    - app.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_dnsnames_list_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "certificate:\n  dnsNames:\n    - app.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_commonname_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "certificate:\n  commonName: app.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_external_hostname_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "route:\n  externalHostname: app.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_external_hostname_pass if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "route:\n  externalHostname: app.example.com\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_url_host_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "webhook:\n  url: https://app.other.com:8443/callback\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_url_host_pass if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "webhook:\n  url: https://app.example.com/callback\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_url_non_http_scheme_is_skipped if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "chart:\n  url: oci.trueforge.org/truecharts\ngit:\n  url: git@github.com:ryanmcafee/homelab.git\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_url_ip_is_skipped if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "webhook:\n  url: http://192.168.1.100:8080/callback\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_values_object_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"valuesObject": {"route": {"hostname": "app.other.com"}}}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_ip_address_host_is_not_a_hostname if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "democratic-csi", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "driver:\n  config:\n    httpConnection:\n      host: 192.168.1.100\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_ip_address_with_port_host_is_not_a_hostname if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "democratic-csi-iscsi", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "driver:\n  config:\n    httpConnection:\n      host: 192.168.1.100:3260\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_bracketed_ipv6_host_is_not_a_hostname if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "config:\n  host: \"[2001:db8::1]:2049\"\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_single_label_hostname_field_is_not_a_hostname if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "tailscale-operator", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "hostname: tailscale-operator-homelab\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_values_no_hostnames_passes if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "replicaCount: 2\nresources:\n  requests:\n    cpu: 10m\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_exempt_hostname if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd", "annotations": {
			"homelab.local/policy-exempt": "hostname-domain",
			"homelab.local/policy-exempt-reason": "test fixture",
		}},
		"spec": {"source": {"helm": {"values": "route:\n  host: app.other.com\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_cluster_service_names_are_skipped if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "db:\n  host: clickhouse.observability.svc.cluster.local\nprometheus:\n  url: http://prometheus.monitoring.svc:9090\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_lookalike_cluster_suffix_still_fails if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "db:\n  host: evil.svc.cluster.local.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}
