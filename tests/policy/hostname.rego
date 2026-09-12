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

# host_call_regex extracts the full argument list of each Host(...) matcher
# call (everything between its parens); quoted_value_regex then pulls every
# quoted value out of that argument list. Two passes are needed because a
# single Host() call can carry multiple hosts, comma-separated:
# Host(`a.example.com`, `b.example.com`).
host_call_regex := `Host\(([^)]*)\)`

quoted_value_regex := "[`\"]([^`\"]+)[`\"]"

# hosts_from_match extracts every Host() matcher host out of a Traefik
# match expression, however many Host() calls or comma-separated hosts per
# call it contains, e.g. all three of:
#   "Host(`traefik.example.com`) && Path(`/dashboard`)"
#   "Host(`a.example.com`, `b.example.com`)"
#   "Host(`a.example.com`) || Host(`b.example.com`, `c.example.com`)"
hosts_from_match(match) := hosts if {
	calls := regex.find_all_string_submatch_n(host_call_regex, match, -1)
	hosts := {h |
		some call in calls
		some m in regex.find_all_string_submatch_n(quoted_value_regex, call[1], -1)
		h := m[1]
	}
}

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
host_key_names := {"host", "hostname", "commonName", "externalHostname"}

host_list_key_names := {"hosts", "dnsNames"}

# url_key_names are field names whose value is a full URL, not a bare
# hostname; host_from_url pulls the hostname out of it.
url_key_names := {"url"}

# is_ip_literal matches a bare IPv4 address or a bracketed IPv6 address,
# each with an optional ":<port>" suffix (e.g. "192.168.1.100:3260",
# "[::1]:2049", "[2001:db8::1]").
is_ip_literal(s) if regex.match(`^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(:[0-9]+)?$`, s)

is_ip_literal(s) if regex.match(`^\[[0-9A-Fa-f:]+\](:[0-9]+)?$`, s)

# looks_like_hostname filters out values that share a key name with a real
# hostname field but aren't one: bare IP addresses, optionally with a port
# (e.g. democratic-csi's `host: 192.168.1.100` NFS/iSCSI server address, or
# an iSCSI portal like `192.168.1.100:3260`) and single-label slugs (e.g.
# Tailscale's `hostname: tailscale-operator-homelab`, a MagicDNS device name
# in the tailnet's own namespace, never suffixed by the cluster domain). A
# real hostname under our domain always has at least one dot.
looks_like_hostname(s) if {
	contains(s, ".")
	not is_ip_literal(s)
}

# url_host_regex pulls the host (and, if present, port) out of an http(s) URL.
# Deliberately anchored to http/https only: a "url" field pointing at an
# oci://, ghcr.io chart reference, ssh git remote, etc. is not a web hostname
# under our domain and must not be checked as one.
url_host_regex := `^https?://([^/:?#]+)`

# host_from_url extracts the hostname out of a "url" value, or is undefined
# for a non-http(s) scheme (chart OCI/registry references, git remotes, ...).
default host_from_url(u) := ""

host_from_url(u) := host if {
	m := regex.find_all_string_submatch_n(url_host_regex, u, 1)
	count(m) == 1
	host := m[0][1]
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
	from_urls := {h |
		walk(value, [path, v])
		count(path) > 0
		key := path[count(path) - 1]
		key in url_key_names
		is_string(v)
		h := host_from_url(v)
		looks_like_hostname(h)
	}
	from_strings := {h |
		walk(value, [_, v])
		is_string(v)
		some h in hosts_from_match(v)
	}
	hosts := ((from_keys | from_lists) | from_urls) | from_strings
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
