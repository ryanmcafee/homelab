package homelab.hostname

import data.homelab.lib

# domain_suffix is the required suffix for every hostname in the cluster:
# "." + the environment's base domain (data.domain, from _data.yaml).
domain_suffix := sprintf(".%s", [lib.domain])

# hostname_kinds are the object kinds this file checks directly (Application
# inline-values are handled separately below and are covered upstream by
# internal/verify.Policy's own missing-domain guard).
hostname_kinds := {"HTTPRoute", "Gateway", "Certificate", "DNSEndpoint"}

# --- Safety net: data.domain missing/undefined must not fail open --------
#
# Every rule below builds domain_suffix from lib.domain. If data.domain is
# absent, lib.domain (and therefore domain_suffix) is undefined, which makes
# every `not in_domain(host)` comparison undefined too -- so the whole rule
# body silently fails to produce a deny message and conftest reports zero
# failures. internal/verify.Policy guards against this by refusing to run
# conftest at all when _data.yaml has no domain, but a bare `conftest test`
# invocation has no such guard, so this rule catches it directly in Rego for
# the kinds hostname-domain actually applies to.
domain_missing if not lib.domain

domain_missing if lib.domain == ""

domain_missing if lib.domain == null

deny contains msg if {
	input.kind in hostname_kinds
	domain_missing
	msg := "[hostname-domain] policy data missing domain"
}

# in_domain accepts the apex domain itself (the wildcard Certificate lists it)
# and every name under it, including "*.<domain>".
in_domain(host) if endswith(host, domain_suffix)

in_domain(host) if host == lib.domain

# --- Direct object checks --------------------------------------------------

# hostname-domain: every HTTPRoute hostname must live under the environment
# domain.
deny contains msg if {
	input.kind == "HTTPRoute"
	not domain_missing
	not lib.is_exempt(input, "hostname-domain")
	some host in object.get(object.get(input, "spec", {}), "hostnames", [])
	not in_domain(host)
	msg := sprintf("[hostname-domain] %s: HTTPRoute hostname %q does not end with %q", [lib.id(input), host, domain_suffix])
}

# hostname-domain: every Gateway listener hostname must live under the
# environment domain.
deny contains msg if {
	input.kind == "Gateway"
	not domain_missing
	not lib.is_exempt(input, "hostname-domain")
	some listener in object.get(object.get(input, "spec", {}), "listeners", [])
	host := listener.hostname
	not in_domain(host)
	msg := sprintf("[hostname-domain] %s: Gateway listener %q hostname %q does not end with %q", [lib.id(input), object.get(listener, "name", ""), host, domain_suffix])
}

# hostname-domain: every cert-manager Certificate dnsNames entry must live
# under the environment domain.
deny contains msg if {
	input.kind == "Certificate"
	not domain_missing
	not lib.is_exempt(input, "hostname-domain")
	some host in object.get(input.spec, "dnsNames", [])
	not in_domain(host)
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
	not in_domain(host)
	msg := sprintf("[hostname-domain] %s: DNSEndpoint dnsName %q does not end with %q", [lib.id(input), host, domain_suffix])
}

# --- Inline helm values on Applications ------------------------------------
#
# Many Applications in this repo configure the remote chart they point to via
# an inline `spec.source.helm.values` YAML string (or, less commonly,
# `valuesObject`) rather than a separate values file -- e.g. a chart's native
# `route.main.hostnames`. Those hostnames are otherwise invisible to every
# rule above, since they never appear as their own HTTPRoute/Certificate/
# DNSEndpoint object at render time.

# host_key_names / host_list_key_names are the field names, anywhere in the
# inline values tree, whose value(s) are treated as a hostname regardless of
# what else is nearby.
host_key_names := {"host", "hostname", "commonName", "externalHostname"}

host_list_key_names := {"hosts", "hostnames", "dnsNames"}

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
	not is_cluster_service(s)
}

# is_cluster_service matches in-cluster Service DNS names (<svc>.<ns>.svc and
# <svc>.<ns>.svc.cluster.local), which never live under the public domain.
is_cluster_service(s) if regex.match(`^[a-z0-9.-]+\.svc(\.cluster\.local)?$`, s)

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
# are also used for non-hostname values elsewhere in this repo's charts)
# and the hosts of http(s) URLs under url_key_names.
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
	hosts := (from_keys | from_lists) | from_urls
}

# hostname-domain: every hostname embedded in an Application's inline helm
# values must live under the environment domain.
deny contains msg if {
	input.kind == "Application"
	input.apiVersion == "argoproj.io/v1alpha1"
	not domain_missing
	not lib.is_exempt(input, "hostname-domain")
	some host in walk_hosts(lib.inline_values(input))
	not in_domain(host)
	msg := sprintf("[hostname-domain] %s: spec.source.helm inline values host %q does not end with %q", [lib.id(input), host, domain_suffix])
}
