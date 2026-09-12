package homelab.hostname

import data.homelab.lib

# domain_suffix is the required suffix for every hostname in the cluster:
# "." + the environment's base domain (data.domain, from _data.yaml).
domain_suffix := sprintf(".%s", [lib.domain])

# hosts_from_match extracts every `Host(\`...\`)` matcher host out of a
# Traefik IngressRoute route's match expression, e.g.
# "Host(`traefik.example.com`) && Path(`/dashboard`)".
hosts_from_match(match) := [h |
	some m in regex.find_all_string_submatch_n("Host\\(`([^`]+)`\\)", match, -1)
	h := m[1]
]

# hostname-domain: every Ingress host must live under the environment domain.
deny contains msg if {
	input.kind == "Ingress"
	not lib.is_exempt(input, "hostname-domain")
	some rule in object.get(input.spec, "rules", [])
	host := rule.host
	not endswith(host, domain_suffix)
	msg := sprintf("[hostname-domain] %s: Ingress host %q does not end with %q", [lib.id(input), host, domain_suffix])
}

# hostname-domain: every Traefik IngressRoute Host() match must live under
# the environment domain.
deny contains msg if {
	input.kind == "IngressRoute"
	not lib.is_exempt(input, "hostname-domain")
	some route in object.get(input.spec, "routes", [])
	some host in hosts_from_match(route.match)
	not endswith(host, domain_suffix)
	msg := sprintf("[hostname-domain] %s: IngressRoute host %q does not end with %q", [lib.id(input), host, domain_suffix])
}

# hostname-domain: every cert-manager Certificate dnsNames entry must live
# under the environment domain.
deny contains msg if {
	input.kind == "Certificate"
	not lib.is_exempt(input, "hostname-domain")
	some host in object.get(input.spec, "dnsNames", [])
	not endswith(host, domain_suffix)
	msg := sprintf("[hostname-domain] %s: Certificate dnsNames entry %q does not end with %q", [lib.id(input), host, domain_suffix])
}

# hostname-domain: every external-dns DNSEndpoint must live under the
# environment domain.
deny contains msg if {
	input.kind == "DNSEndpoint"
	not lib.is_exempt(input, "hostname-domain")
	some ep in object.get(input.spec, "endpoints", [])
	host := ep.dnsName
	not endswith(host, domain_suffix)
	msg := sprintf("[hostname-domain] %s: DNSEndpoint dnsName %q does not end with %q", [lib.id(input), host, domain_suffix])
}
