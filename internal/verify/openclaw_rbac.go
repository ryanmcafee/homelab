package verify

import (
	"fmt"
	"strings"
)

// validateOpenClawRBAC deliberately accepts a narrow, auditable graph. Unknown
// bindings and aggregation fail closed instead of guessing external cluster state.
func validateOpenClawRBAC(data []byte, operatorNamespace, instanceNamespace string) error {
	fail := func(s string, args ...any) error { return fmt.Errorf("OpenClaw RBAC: "+s, args...) }
	if operatorNamespace == "" || instanceNamespace == "" || operatorNamespace == instanceNamespace {
		return fail("require distinct operator and instance namespaces")
	}
	docs, err := ParseMultiDoc("openclaw-upstream", "", data)
	if err != nil {
		return fail("parse full chart: %v", err)
	}
	if len(docs) == 0 {
		return fail("full chart render is empty")
	}
	roles := map[string]Doc{}
	accounts := map[string]bool{}
	seen := map[string]bool{}
	var bindings, deployments []Doc
	effectiveNS := func(d Doc) string {
		if d.Namespace() != "" {
			return d.Namespace()
		}
		return operatorNamespace
	}
	for _, d := range docs {
		if d.Name() == "" || d.Kind() == "" || d.APIVersion() == "" {
			return fail("unparsed/incomplete manifest: %s", d.ID())
		}
		ns := effectiveNS(d)
		if d.Kind() == "ClusterRole" || d.Kind() == "ClusterRoleBinding" || d.Kind() == "CustomResourceDefinition" {
			ns = ""
		}
		key := d.Group() + "/" + d.Kind() + "/" + ns + "/" + d.Name()
		if seen[key] {
			return fail("duplicate object %s", key)
		}
		seen[key] = true
		if d.Kind() == "List" || strings.HasSuffix(d.Kind(), "List") {
			return fail("unexpanded list %s; inspect every individual manifest", d.ID())
		}
		if d.Group() == "rbac.authorization.k8s.io" && d.Kind() != "Role" && d.Kind() != "ClusterRole" && d.Kind() != "RoleBinding" && d.Kind() != "ClusterRoleBinding" {
			return fail("unsupported RBAC object %s", d.ID())
		}
		switch d.Kind() {
		case "ServiceAccount":
			if d.APIVersion() != "v1" || ns != operatorNamespace {
				return fail("unexpected ServiceAccount %s", d.ID())
			}
			accounts[d.Name()] = true
		case "Deployment":
			if d.APIVersion() != "apps/v1" || ns != operatorNamespace {
				return fail("unexpected controller Deployment %s", d.ID())
			}
			deployments = append(deployments, d)
		case "Pod", "Job", "CronJob", "StatefulSet", "DaemonSet", "ReplicaSet", "ReplicationController":
			return fail("unexpected workload %s; review its ServiceAccount before allowing it", d.ID())
		case "Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding":
			if d.APIVersion() != "rbac.authorization.k8s.io/v1" {
				return fail("unexpected RBAC apiVersion on %s", d.ID())
			}
			cluster := strings.HasPrefix(d.Kind(), "Cluster")
			if cluster && d.Namespace() != "" {
				return fail("cluster-scoped object carries namespace: %s", d.ID())
			}
			if !cluster && ns != operatorNamespace && ns != instanceNamespace {
				return fail("unexpected namespace on %s", d.ID())
			}
			if strings.HasSuffix(d.Kind(), "Binding") {
				bindings = append(bindings, d)
				continue
			}
			if _, exists := d.Object["aggregationRule"]; exists {
				return fail("aggregationRule on %s is not allowed", d.ID())
			}
			for label := range d.Labels() {
				if strings.HasPrefix(label, "rbac.authorization.k8s.io/aggregate-to-") {
					return fail("aggregate-to-default role output %s", d.ID())
				}
			}
			for _, suffix := range []string{"-admin", "-edit", "-view"} {
				if d.Kind() == "ClusterRole" && strings.HasSuffix(d.Name(), suffix) {
					return fail("aggregate-to-default role output %s", d.ID())
				}
			}
			roles[d.Kind()+"/"+ns+"/"+d.Name()] = d
		}
	}
	if len(deployments) != 1 || len(accounts) != 1 {
		return fail("require exactly one controller Deployment and ServiceAccount (got %d/%d)", len(deployments), len(accounts))
	}
	sa := deployments[0].GetString("spec", "template", "spec", "serviceAccountName")
	if sa == "" || !accounts[sa] {
		return fail("controller ServiceAccount %q is missing from full render", sa)
	}
	if len(bindings) == 0 || len(roles) == 0 {
		return fail("missing RBAC roles or bindings")
	}
	used := map[string]bool{}
	instanceSecrets, operatorSecrets, clusterDefaults := false, false, false
	for _, binding := range bindings {
		subjects, ok := binding.Object["subjects"].([]any)
		if !ok || len(subjects) != 1 {
			return fail("unexpected/missing subjects on %s", binding.ID())
		}
		subject, ok := subjects[0].(map[string]any)
		if !ok {
			return fail("malformed subject on %s", binding.ID())
		}
		// Group grants (system:authenticated/serviceaccounts), and User grants to
		// system:serviceaccount:<namespace>:<name> are all unexpected, not ignored.
		if subject["kind"] != "ServiceAccount" || subject["name"] != sa || subject["namespace"] != operatorNamespace || (subject["apiGroup"] != nil && subject["apiGroup"] != "") {
			return fail("unexpected binding subject on %s; only operator ServiceAccount %s/%s is allowed", binding.ID(), operatorNamespace, sa)
		}
		ref, ok := binding.Object["roleRef"].(map[string]any)
		if !ok || ref["apiGroup"] != "rbac.authorization.k8s.io" {
			return fail("invalid roleRef on %s", binding.ID())
		}
		kind, kok := ref["kind"].(string)
		name, nok := ref["name"].(string)
		if !kok || !nok || name == "" || (kind != "Role" && kind != "ClusterRole") {
			return fail("invalid roleRef on %s", binding.ID())
		}
		scope := effectiveNS(binding)
		if binding.Kind() == "ClusterRoleBinding" {
			scope = ""
			if kind != "ClusterRole" {
				return fail("ClusterRoleBinding must reference ClusterRole: %s", binding.ID())
			}
		}
		roleNS := scope
		if kind == "ClusterRole" {
			roleNS = ""
		}
		key := kind + "/" + roleNS + "/" + name
		role, ok := roles[key]
		if !ok {
			return fail("unresolved roleRef %s on %s", key, binding.ID())
		}
		used[key] = true
		rules, ok := role.Object["rules"].([]any)
		if !ok || len(rules) == 0 {
			return fail("missing/malformed rules on %s", role.ID())
		}
		for _, raw := range rules {
			rule, ok := raw.(map[string]any)
			if !ok {
				return fail("malformed rule on %s", role.ID())
			}
			for key := range rule {
				if key != "apiGroups" && key != "resources" && key != "verbs" && key != "resourceNames" {
					return fail("unsupported rule field %s on %s", key, role.ID())
				}
			}
			groups, err := rbacStrings(rule["apiGroups"], true)
			if err != nil {
				return fail("%s apiGroups: %v", role.ID(), err)
			}
			resources, err := rbacStrings(rule["resources"], false)
			if err != nil {
				return fail("%s resources: %v", role.ID(), err)
			}
			verbs, err := rbacStrings(rule["verbs"], false)
			if err != nil {
				return fail("%s verbs: %v", role.ID(), err)
			}
			if names, exists := rule["resourceNames"]; exists {
				if _, err := rbacStrings(names, false); err != nil {
					return fail("%s resourceNames: %v", role.ID(), err)
				}
			}
			for _, g := range groups {
				for _, resource := range resources {
					for _, verb := range verbs {
						if strings.Contains(g, "*") || strings.Contains(resource, "*") || strings.Contains(verb, "*") {
							return fail("wildcard grant %s/%s:%s via %s", g, resource, verb, binding.ID())
						}
						read := verb == "get" || verb == "list" || verb == "watch"
						normal := read || verb == "create" || verb == "update" || verb == "patch" || verb == "delete" || verb == "deletecollection"
						if !normal {
							return fail("unexpected verb %q via %s", verb, binding.ID())
						}
						if scope == "" {
							if g != "openclaw.rocks" || resource != "openclawclusterdefaults" || !read {
								return fail("cluster grant %s/%s:%s via %s is outside the read-only defaults allowlist", g, resource, verb, binding.ID())
							}
							clusterDefaults = true
						} else if scope == operatorNamespace {
							switch {
							case g == "" && resource == "secrets" && read:
								operatorSecrets = true
							case g == "" && (resource == "configmaps" || resource == "events"):
							case g == "coordination.k8s.io" && resource == "leases":
							default:
								return fail("operator-namespace grant %s/%s:%s via %s is outside read-only Secrets and leader-election resources", g, resource, verb, binding.ID())
							}
						} else if g == "" && resource == "secrets" {
							instanceSecrets = true
						}
					}
				}
			}
		}
	}
	for key := range roles {
		if !used[key] && !openClawUnboundMetricsReader(roles[key]) {
			return fail("unexpected unbound role %s", key)
		}
	}
	if !instanceSecrets || !operatorSecrets || !clusterDefaults {
		return fail("incomplete RBAC render: require instance Secrets, operator read-only Secrets and cluster defaults bindings")
	}
	return nil
}

func rbacStrings(value any, allowEmpty bool) ([]string, error) {
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return nil, fmt.Errorf("expected nonempty string array")
	}
	out := make([]string, 0, len(values))
	for _, v := range values {
		s, ok := v.(string)
		if !ok || (!allowEmpty && s == "") {
			return nil, fmt.Errorf("expected string entries")
		}
		out = append(out, s)
	}
	return out, nil
}

// metrics.enabled emits an unbound reader role for Prometheus. It grants the
// operator nothing; accept only this exact non-resource GET rule, never Secrets.
func openClawUnboundMetricsReader(d Doc) bool {
	if d.Kind() != "ClusterRole" || !strings.HasSuffix(d.Name(), "-metrics-reader") {
		return false
	}
	rules := d.GetSlice("rules")
	if len(rules) != 1 {
		return false
	}
	rule, ok := rules[0].(map[string]any)
	if !ok || len(rule) != 2 {
		return false
	}
	urls, err := rbacStrings(rule["nonResourceURLs"], false)
	if err != nil || len(urls) != 1 || urls[0] != "/metrics" {
		return false
	}
	verbs, err := rbacStrings(rule["verbs"], false)
	return err == nil && len(verbs) == 1 && verbs[0] == "get"
}
