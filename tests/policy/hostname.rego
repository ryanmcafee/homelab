package homelab.hostname

import data.homelab.lib

# domain_suffix is the required suffix for every hostname in the cluster:
# "." + the environment's base domain (data.domain, from _data.yaml).
domain_suffix := sprintf(".%s", [lib.domain])

# hostname_kinds are the object kinds this file checks directly (Application
# inline-values are handled separately below and are covered upstream by
# internal/verify.Policy's own missing-domain guard).
hostname_kinds := {"Ingress", "IngressRoute", "Certificate", "DNSEndpoint"}

# --- Safety net: data.domain missing/undefined must not fail open --------
#
# Every rule below builds domain_suffix from lib.domain. If data.domain is
# absent, lib.domain (and therefore domain_suffix) is undefined, which makes
# every `not endswith(host, domain_suffix)` comparison undefined too — so the
# whole rule body silently fails to produce a deny message and conftest
# reports zero failures. internal/verify.Policy guards against this by
# refusing to run conftest at all when _data.yaml has no domain, but a bare
# `conftest test` invocation has no such guard, so this rule catches it
# directly in Rego for the kinds hostname-domain actually applies to.
domain_missing if not lib.domain

domain_missing if lib.domain == ""

domain_missing if lib.domain == null

deny contains msg if {
	input.kind in hostname_kinds
	domain_missing
	msg := "[hostname-domain] policy data missing domain"
}

# --- Direct object checks --------------------------------------------------

# hostname_regex matches a Traefik matcher's `Host(...)` argument, whether
# it's backtick-quoted (Host(`x`)) or double-quoted (Host("x")).
hostname_regex := "Host\\(\\s*[`\"]([^`\"]+)[`\"]\\s*\\)"

# hosts_from_match extracts every Host() matcher host out of a Traefik
# IngressRoute route's match expression, e.g.
# "Host(`traefik.example.com`) && Path(`/dashboard`)".
hosts_from_match(match) := [h |
	some m in regex.find_all_string_submatch_n(hostname_regex, match, -1)
	h := m[1]
]

# hostname-domain: every Ingress host must live under the environment domain.
deny contains msg if {
	input.kind == "Ingress"
	not domain_missing
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
	not domain_missing
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
	not domain_missing
	not lib.is_exempt(input, "hostname-domain")
	some host in object.get(input.spec, "dnsNames", [])
	not endswith(host, domain_suffix)
	msg := sprintf("[hostname-domain] %s: Certificate dnsNames entry %q does not end with %q", [lib.id(input), host, domain_suffix])
}

# hostname-domain: every external-dns DNSEndpoint must live under the
# environment domain.
deny contains msg if {
	input.kind == "DNSEndpoint"
	not domain_missing
	not lib.is_exempt(input, "hostname-domain")
	some ep in object.get(input.spec, "endpoints", [])
	host := ep.dnsName
	not endswith(host, domain_suffix)
	msg := sprintf("[hostname-domain] %s: DNSEndpoint dnsName %q does not end with %q", [lib.id(input), host, domain_suffix])
}

# --- Inline helm values on Applications ------------------------------------
#
# Many Applications in this repo configure the remote chart they point to via
# an inline `spec.source.helm.values` YAML string (or, less commonly,
# `valuesObject`) rather than a separate values file — e.g. the Traefik
# addons Applications set `ingressRoute.dashboard.matchRule: Host(...)`
# this way. Those hostnames are otherwise invisible to every rule above,
# since they never appear as their own Ingress/IngressRoute/Certificate/
# DNSEndpoint object at render time.

default helm_values_string(helm) := {}

helm_values_string(helm) := yaml.unmarshal(helm.values) if is_string(helm.values)

default helm_values_object(helm) := {}

helm_values_object(helm) := helm.valuesObject if is_object(helm.valuesObject)

default inline_values(obj) := {}

inline_values(obj) := merged if {
	helm := object.get(object.get(obj.spec, "source", {}), "helm", {})
	merged := object.union(helm_values_string(helm), helm_values_object(helm))
}

# host_key_names / host_list_key_names are the field names, anywhere in the
# inline values tree, whose value(s) are treated as a hostname regardless of
# what else is nearby.
host_key_names := {"host", "hostname", "commonName"}

host_list_key_names := {"hosts", "dnsNames"}

# looks_like_hostname filters out values that share a key name with a real
# hostname field but aren't one: bare IPv4 addresses (e.g. democratic-csi's
# `host: 192.168.1.100` NFS/iSCSI server address) and single-label slugs
# (e.g. Tailscale's `hostname: tailscale-operator-homelab`, a MagicDNS device
# name in the tailnet's own namespace, never suffixed by the cluster domain).
# A real hostname under our domain always has at least one dot.
looks_like_hostname(s) if {
	contains(s, ".")
	not regex.match(`^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$`, s)
}

# walk_hosts collects every hostname reachable inside an arbitrary
# (already-parsed) values tree: values under host_key_names /
# host_list_key_names (filtered by looks_like_hostname, since those key names
# are also used for non-hostname values elsewhere in this repo's charts),
# plus any Host(...) matcher embedded in any string anywhere in the tree
# (e.g. an IngressRoute matchRule — those are unambiguous, so no filter).
walk_hosts(value) := hosts if {
	from_keys := {h |
		walk(value, [path, v])
		count(path) > 0
		key := path[count(path) - 1]
		key in host_key_names
		is_string(v)
		looks_like_hostname(v)
		h := v
	}
	from_lists := {h |
		walk(value, [path, v])
		count(path) > 0
		key := path[count(path) - 1]
		key in host_list_key_names
		is_array(v)
		some h in v
		is_string(h)
		looks_like_hostname(h)
	}
	from_strings := {h |
		walk(value, [_, v])
		is_string(v)
		some h in hosts_from_match(v)
	}
	hosts := (from_keys | from_lists) | from_strings
}

# hostname-domain: every hostname embedded in an Application's inline helm
# values must live under the environment domain.
deny contains msg if {
	input.kind == "Application"
	input.apiVersion == "argoproj.io/v1alpha1"
	not domain_missing
	not lib.is_exempt(input, "hostname-domain")
	some host in walk_hosts(inline_values(input))
	not endswith(host, domain_suffix)
	msg := sprintf("[hostname-domain] %s: spec.source.helm inline values host %q does not end with %q", [lib.id(input), host, domain_suffix])
}
