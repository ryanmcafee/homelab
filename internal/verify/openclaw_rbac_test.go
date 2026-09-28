package verify

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestOpenClawRBACFixtures(t *testing.T) {
	for _, tc := range []struct {
		file string
		bad  bool
	}{{"scoped-0.40.0.yaml", false}, {"cluster-wide-0.40.0.yaml", true}} {
		t.Run(tc.file, func(t *testing.T) {
			data, err := os.ReadFile("testdata/openclaw/" + tc.file)
			if err != nil {
				t.Fatal(err)
			}
			err = validateOpenClawRBAC(data, "openclaw-system", "openclaw")
			if (err != nil) != tc.bad {
				t.Fatalf("err=%v want bad=%v", err, tc.bad)
			}
			t.Logf("policy result: %v", err)
		})
	}
}

func TestOpenClawRBACRejectsInjectedGrants(t *testing.T) {
	raw, err := os.ReadFile("testdata/openclaw/scoped-0.40.0.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		mutate func([]Doc) []Doc
	}{
		{"cluster secret", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").Object["rules"] = []any{rbacRule("", "secrets", "get")}
			return d
		}},
		{"cluster wildcard api", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").Object["rules"] = []any{rbacRule("*", "secrets", "get")}
			return d
		}},
		{"cluster wildcard resources", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").Object["rules"] = []any{rbacRule("", "*", "get")}
			return d
		}},
		{"cluster wildcard verbs", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").Object["rules"] = []any{rbacRule("", "secrets", "*")}
			return d
		}},
		{"defaults mutation", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").Object["rules"] = []any{rbacRule("openclaw.rocks", "openclawclusterdefaults", "patch")}
			return d
		}},
		{"operator secrets mutation", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-operator-ns").Object["rules"] = []any{rbacRule("", "secrets", "patch")}
			return d
		}},
		{"operator wildcard", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-operator-ns").Object["rules"] = []any{rbacRule("*", "*", "*")}
			return d
		}},
		{"operator workloads", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-operator-ns").Object["rules"] = []any{rbacRule("", "pods", "create")}
			return d
		}},
		{"third namespace", func(d []Doc) []Doc {
			roleSuffix(d, "manager-rolebinding").Object["metadata"].(map[string]any)["namespace"] = "other"
			return d
		}},
		{"aggregation selector", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").Object["aggregationRule"] = map[string]any{"clusterRoleSelectors": []any{map[string]any{}}}
			return d
		}},
		{"aggregate default role", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").Object["metadata"].(map[string]any)["labels"] = map[string]any{"rbac.authorization.k8s.io/aggregate-to-admin": "true"}
			return d
		}},
		{"group binding", func(d []Doc) []Doc {
			roleKind(d, "ClusterRoleBinding").Object["subjects"] = []any{map[string]any{"kind": "Group", "name": "system:authenticated", "apiGroup": "rbac.authorization.k8s.io"}}
			return d
		}},
		{"user binding", func(d []Doc) []Doc {
			roleKind(d, "ClusterRoleBinding").Object["subjects"] = []any{map[string]any{"kind": "User", "name": "system:serviceaccount:openclaw-system:openclaw-operator", "apiGroup": "rbac.authorization.k8s.io"}}
			return d
		}},
		{"other serviceaccount", func(d []Doc) []Doc {
			roleKind(d, "ClusterRoleBinding").GetSlice("subjects")[0].(map[string]any)["name"] = "other"
			return d
		}},
		{"unresolved binding", func(d []Doc) []Doc {
			roleKind(d, "ClusterRoleBinding").Object["roleRef"].(map[string]any)["name"] = "cluster-admin"
			return d
		}},
		{"malformed rules", func(d []Doc) []Doc { roleSuffix(d, "manager-role-cluster").Object["rules"] = "oops"; return d }},
		{"malformed verb", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").GetSlice("rules")[0].(map[string]any)["verbs"] = []any{7}
			return d
		}},
		{"missing deployment", func(d []Doc) []Doc {
			var out []Doc
			for _, v := range d {
				if v.Kind() != "Deployment" {
					out = append(out, v)
				}
			}
			return out
		}},
		{"missing serviceaccount", func(d []Doc) []Doc {
			var out []Doc
			for _, v := range d {
				if v.Kind() != "ServiceAccount" {
					out = append(out, v)
				}
			}
			return out
		}},
		{"duplicate role", func(d []Doc) []Doc { return append(d, *roleSuffix(d, "manager-role-cluster")) }},
		{"unparsed object", func(d []Doc) []Doc { return append(d, Doc{Object: map[string]any{"garbage": true}}) }},
		{"list hidden grant", func(d []Doc) []Doc {
			return append(d, Doc{Object: map[string]any{"apiVersion": "v1", "kind": "List", "metadata": map[string]any{"name": "hidden"}, "items": []any{roleSuffix(d, "manager-role-cluster").Object}}})
		}},
		{"non resource URLs", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role-cluster").GetSlice("rules")[0].(map[string]any)["nonResourceURLs"] = []any{"*"}
			return d
		}},
		{"escalation verb", func(d []Doc) []Doc {
			roleSuffix(d, "manager-role").Object["rules"] = []any{rbacRule("rbac.authorization.k8s.io", "roles", "escalate")}
			return d
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			docs, err := ParseMultiDoc("", "", raw)
			if err != nil {
				t.Fatal(err)
			}
			docs = tc.mutate(docs)
			var out strings.Builder
			for _, d := range docs {
				b, err := yaml.Marshal(d.Object)
				if err != nil {
					t.Fatal(err)
				}
				out.WriteString("---\n")
				out.Write(b)
			}
			err = validateOpenClawRBAC([]byte(out.String()), "openclaw-system", "openclaw")
			if err == nil {
				t.Fatal("unsafe injected render passed")
			}
			t.Log(err)
		})
	}
	for _, raw := range []string{"", "[bad", "---\nnull\n"} {
		if err := validateOpenClawRBAC([]byte(raw), "openclaw-system", "openclaw"); err == nil {
			t.Fatalf("missing/malformed stream passed: %q", raw)
		}
	}
}
func rbacRule(group, resource, verb string) map[string]any {
	return map[string]any{"apiGroups": []any{group}, "resources": []any{resource}, "verbs": []any{verb}}
}
func roleKind(d []Doc, kind string) *Doc {
	for i := range d {
		if d[i].Kind() == kind {
			return &d[i]
		}
	}
	panic("missing test role kind " + kind)
}
func roleSuffix(d []Doc, suffix string) *Doc {
	for i := range d {
		if strings.HasSuffix(d[i].Name(), suffix) {
			return &d[i]
		}
	}
	panic("missing test role suffix " + suffix)
}

// Set this to a directory of independently fetched FULL chart renders to
// prove the offline projections did not hide a grant in another template.
func TestOpenClawFullChartRenders(t *testing.T) {
	dir := os.Getenv("HOMELAB_TEST_OPENCLAW_RENDER_DIR")
	if dir == "" {
		t.Skip("full renders supplied only by integration verification")
	}
	for _, tc := range []struct {
		file string
		bad  bool
	}{{"scoped.yaml", false}, {"unscoped.yaml", true}, {"aggregated.yaml", true}} {
		t.Run(tc.file, func(t *testing.T) {
			data, err := os.ReadFile(dir + "/" + tc.file)
			if err != nil {
				t.Fatal(err)
			}
			err = validateOpenClawRBAC(data, "openclaw-system", "openclaw")
			if (err != nil) != tc.bad {
				t.Fatalf("err=%v want bad=%v", err, tc.bad)
			}
			t.Logf("full-chart result: %v", err)
		})
	}
}

func TestOpenClawMetricsReaderCannotHideGrants(t *testing.T) {
	raw, err := os.ReadFile("testdata/openclaw/scoped-0.40.0.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		mutate func([]Doc)
	}{
		{"secret rule", func(d []Doc) { roleSuffix(d, "metrics-reader").Object["rules"] = []any{rbacRule("", "secrets", "get")} }},
		{"wildcard URL", func(d []Doc) {
			roleSuffix(d, "metrics-reader").GetSlice("rules")[0].(map[string]any)["nonResourceURLs"] = []any{"*"}
		}},
		{"bound to controller", func(d []Doc) {
			roleKind(d, "ClusterRoleBinding").Object["roleRef"].(map[string]any)["name"] = roleSuffix(d, "metrics-reader").Name()
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			docs, err := ParseMultiDoc("", "", raw)
			if err != nil {
				t.Fatal(err)
			}
			tc.mutate(docs)
			var out strings.Builder
			for _, d := range docs {
				b, err := yaml.Marshal(d.Object)
				if err != nil {
					t.Fatal(err)
				}
				out.WriteString("---\n")
				out.Write(b)
			}
			if err := validateOpenClawRBAC([]byte(out.String()), "openclaw-system", "openclaw"); err == nil {
				t.Fatal("unexpected metrics grant passed")
			}
		})
	}
}
