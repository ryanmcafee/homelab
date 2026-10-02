package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// renderWith builds a one-env, one-chart render from YAML documents.
func renderWith(t *testing.T, docs ...string) map[string]map[string][]Doc {
	t.Helper()
	parsed, err := ParseMultiDoc("addons", "homelab", []byte(strings.Join(docs, "\n---\n")))
	if err != nil {
		t.Fatalf("parsing test render: %v", err)
	}
	return map[string]map[string][]Doc{"homelab": {"addons": parsed}}
}

// repoWithRunbooks writes a fake repo root whose runbooks name each body.
func repoWithRunbooks(t *testing.T, bodies ...string) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, filepath.FromSlash(RunbooksDir))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating runbook dir: %v", err)
	}
	for i, body := range bodies {
		name := filepath.Join(dir, "runbook"+string(rune('a'+i))+".md")
		if err := os.WriteFile(name, []byte(body), 0o644); err != nil {
			t.Fatalf("writing runbook: %v", err)
		}
	}
	return root
}

const prometheusRuleDoc = `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: direct
  namespace: monitoring
spec:
  groups:
    - name: direct
      rules:
        - alert: HomelabDirectRule
          expr: up == 0
`

// applicationDoc nests its rules inside the Helm values string, which is how
// every alert in charts/addons actually reaches the cluster.
const applicationDoc = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: kube-prometheus-stack
  namespace: argocd
spec:
  source:
    helm:
      values: |
        additionalPrometheusRulesMap:
          homelab-control-plane:
            groups:
              - name: homelab-control-plane
                rules:
                  - alert: HomelabNestedRule
                    expr: up == 0
`

func TestCollectAlertsReadsBothDeclarationShapes(t *testing.T) {
	alerts, err := CollectAlerts(renderWith(t, prometheusRuleDoc, applicationDoc))
	if err != nil {
		t.Fatalf("CollectAlerts: %v", err)
	}
	got := map[string]bool{}
	for _, a := range alerts {
		got[a.Name] = true
	}
	for _, want := range []string{"HomelabDirectRule", "HomelabNestedRule"} {
		if !got[want] {
			t.Errorf("CollectAlerts missed %s; found %v", want, got)
		}
	}
}

func TestRunbookCoveragePassesWhenEveryAlertIsNamed(t *testing.T) {
	root := repoWithRunbooks(t, "# Runbook\n\nHomelabDirectRule: check the node.\nHomelabNestedRule: check the API server.\n")
	checks := RunbookCoverage(root, renderWith(t, prometheusRuleDoc, applicationDoc))
	if len(checks) != 1 || checks[0].Status != StatusPass {
		t.Fatalf("want one passing check, got %+v", checks)
	}
}

func TestRunbookCoverageFailsOnAnAlertWithNoRunbook(t *testing.T) {
	root := repoWithRunbooks(t, "# Runbook\n\nHomelabDirectRule: check the node.\n")
	checks := RunbookCoverage(root, renderWith(t, prometheusRuleDoc, applicationDoc))
	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("want one failing check, got %+v", checks)
	}
	if len(checks[0].Findings) != 1 || !strings.Contains(checks[0].Findings[0], "HomelabNestedRule") {
		t.Errorf("want a finding naming HomelabNestedRule, got %v", checks[0].Findings)
	}
}

// A substring reader passes this: "HomelabDirectRule" occurs inside
// "HomelabDirectRuleExpired". Exact token membership is what makes the longer
// alert report as uncovered.
func TestRunbookCoverageDoesNotAcceptAPrefixOfAnAlertName(t *testing.T) {
	const longerName = `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: direct
  namespace: monitoring
spec:
  groups:
    - name: direct
      rules:
        - alert: HomelabDirectRuleExpired
          expr: up == 0
`
	root := repoWithRunbooks(t, "# Runbook\n\nHomelabDirectRule: check the node.\n")
	checks := RunbookCoverage(root, renderWith(t, longerName))
	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("want a failing check for the longer alert name, got %+v", checks)
	}
}

// A render the collector no longer understands must not report success: the
// check would otherwise be green for every future alert as well.
func TestRunbookCoverageFailsOnARenderWithNoAlerts(t *testing.T) {
	root := repoWithRunbooks(t, "# Runbook\n")
	checks := RunbookCoverage(root, renderWith(t, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: nothing\n"))
	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("want a failing check when the render ships no alert, got %+v", checks)
	}
	if !strings.Contains(checks[0].Detail, "proves nothing") {
		t.Errorf("want the empty-render detail to say the check proves nothing, got %q", checks[0].Detail)
	}
}

func TestRunbookCoverageFailsWhenNoRunbookIsRead(t *testing.T) {
	root := repoWithRunbooks(t)
	checks := RunbookCoverage(root, renderWith(t, prometheusRuleDoc))
	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("want a failing check when no runbook is read, got %+v", checks)
	}
	if !strings.Contains(strings.Join(checks[0].Findings, " "), "0 *.md files") {
		t.Errorf("want a finding naming the empty runbook directory, got %v", checks[0].Findings)
	}
}

// The union across environments is the point: an alert that only renders for
// homelab still pages an operator.
func TestRunbookCoverageUnionsEnvironments(t *testing.T) {
	homelabOnly, err := ParseMultiDoc("addons", "homelab", []byte(prometheusRuleDoc))
	if err != nil {
		t.Fatalf("parsing homelab render: %v", err)
	}
	localdev, err := ParseMultiDoc("addons", "localdev", []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: nothing\n"))
	if err != nil {
		t.Fatalf("parsing localdev render: %v", err)
	}
	rendered := map[string]map[string][]Doc{
		"homelab":  {"addons": homelabOnly},
		"localdev": {"addons": localdev},
	}
	root := repoWithRunbooks(t, "# Runbook\n\nnothing relevant\n")
	checks := RunbookCoverage(root, rendered)
	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("want the homelab-only alert to fail, got %+v", checks)
	}
	if !strings.Contains(strings.Join(checks[0].Findings, " "), "homelab/addons") {
		t.Errorf("want the finding to name the environment it renders from, got %v", checks[0].Findings)
	}
}
