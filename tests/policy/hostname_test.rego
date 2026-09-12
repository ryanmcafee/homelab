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
