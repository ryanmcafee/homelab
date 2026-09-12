package homelab.hostname

test_ingress_pass if {
	obj := {"kind": "Ingress", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"rules": [{"host": "app.example.com"}]}}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_ingress_fail if {
	obj := {"kind": "Ingress", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"rules": [{"host": "app.other.com"}]}}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_ingressroute_pass if {
	obj := {
		"kind": "IngressRoute",
		"metadata": {"name": "x", "namespace": "ns"},
		"spec": {"routes": [{"match": "Host(`traefik.example.com`) && Path(`/dashboard`)"}]},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_ingressroute_fail if {
	obj := {"kind": "IngressRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"routes": [{"match": "Host(`traefik.other.com`)"}]}}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_ingressroute_comma_form_pass if {
	obj := {"kind": "IngressRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"routes": [{"match": "Host(`a.example.com`, `b.example.com`)"}]}}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_ingressroute_comma_form_catches_second_host if {
	obj := {"kind": "IngressRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"routes": [{"match": "Host(`a.example.com`, `b.other.com`)"}]}}
	some m in deny with input as obj with data.domain as "example.com"
	contains(m, "b.other.com")
}

test_ingressroute_or_form_catches_second_call if {
	obj := {"kind": "IngressRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"routes": [{"match": "Host(`a.example.com`) || Host(`b.other.com`)"}]}}
	some m in deny with input as obj with data.domain as "example.com"
	contains(m, "b.other.com")
}

test_ingressroute_mixed_or_and_comma_form_catches_all if {
	obj := {"kind": "IngressRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"routes": [{"match": "Host(`a.example.com`) || Host(`b.other.com`, `c.other.com`)"}]}}
	msgs := {m | some m in deny} with input as obj with data.domain as "example.com"
	count(msgs) == 2
	some m1 in msgs
	contains(m1, "b.other.com")
	some m2 in msgs
	contains(m2, "c.other.com")
}

test_ingressroute_mixed_or_and_comma_form_pass if {
	obj := {"kind": "IngressRoute", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"routes": [{"match": "Host(`a.example.com`) || Host(`b.example.com`, `c.example.com`)"}]}}
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
	obj := {"kind": "DNSEndpoint", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"endpoints": [{"dnsName": "traefik.example.com", "recordType": "A"}]}}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_dnsendpoint_fail if {
	obj := {"kind": "DNSEndpoint", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"endpoints": [{"dnsName": "traefik.other.com", "recordType": "A"}]}}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_exempt_hostname if {
	obj := {
		"kind": "Ingress",
		"metadata": {"name": "x", "namespace": "ns", "annotations": {
			"homelab.ryanmcafee.com/policy-exempt": "hostname-domain",
			"homelab.ryanmcafee.com/policy-exempt-reason": "test fixture",
		}},
		"spec": {"rules": [{"host": "app.other.com"}]},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

# --- domain-missing safety net ---------------------------------------------

test_domain_missing_fires_for_ingress if {
	obj := {"kind": "Ingress", "metadata": {"name": "x", "namespace": "ns"}, "spec": {"rules": [{"host": "app.example.com"}]}}
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

test_inline_matchrule_pass if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "traefik-external", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "ingressRoute:\n  dashboard:\n    matchRule: Host(`traefik.example.com`)\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}

test_inline_matchrule_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "traefik-external", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "ingressRoute:\n  dashboard:\n    matchRule: Host(`traefik.other.com`)\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_host_key_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "ingress:\n  host: app.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_hosts_list_fail if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "ingress:\n  hosts:\n    - app.example.com\n    - app.other.com\n"}}},
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
		"spec": {"source": {"helm": {"values": "ingress:\n  externalHostname: app.other.com\n"}}},
	}
	some m in deny with input as obj with data.domain as "example.com"
	startswith(m, "[hostname-domain]")
}

test_inline_external_hostname_pass if {
	obj := {
		"kind": "Application",
		"apiVersion": "argoproj.io/v1alpha1",
		"metadata": {"name": "app", "namespace": "argocd"},
		"spec": {"source": {"helm": {"values": "ingress:\n  externalHostname: app.example.com\n"}}},
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
		"spec": {"source": {"helm": {"valuesObject": {"ingress": {"hostname": "app.other.com"}}}}},
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
			"homelab.ryanmcafee.com/policy-exempt": "hostname-domain",
			"homelab.ryanmcafee.com/policy-exempt-reason": "test fixture",
		}},
		"spec": {"source": {"helm": {"values": "ingress:\n  host: app.other.com\n"}}},
	}
	count(deny) == 0 with input as obj with data.domain as "example.com"
}
