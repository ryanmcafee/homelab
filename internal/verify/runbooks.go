package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// RunbooksDir is the repo-relative directory an alert's runbook lives in. An
// alert nobody can act on is noise that trains an operator to ignore the next
// one, so naming the alert in a runbook here is what makes it actionable.
const RunbooksDir = "docs/runbooks"

// runbookToken matches an identifier-shaped word in a runbook. Coverage is
// decided by exact token membership rather than a substring search on purpose:
// `strings.Contains` reports a runbook that only documents
// `HomelabEnvoyUpstreamErrors` as also covering a later
// `HomelabEnvoyUpstreamError`, and the alert that silently inherits that green
// is exactly the one with no runbook.
var runbookToken = regexp.MustCompile(`[A-Za-z][A-Za-z0-9_]{2,}`)

// ShippedAlert is one alerting rule found in a rendered manifest.
type ShippedAlert struct {
	// Name is the rule's `alert:` value, e.g. "HomelabNodeNotReady".
	Name string
	// Env is the environment the rule renders for ("localdev" | "homelab").
	Env string
	// Chart is the chart directory the rule renders from, e.g. "addons".
	Chart string
	// Owner is the enclosing object, so a finding points at the manifest to
	// edit rather than only at the alert name.
	Owner string
}

// Source renders the alert's origin as one line of a check's findings.
func (a ShippedAlert) Source() string {
	return fmt.Sprintf("%s/%s %s", a.Env, a.Chart, a.Owner)
}

// collectAlertNames walks an arbitrary decoded YAML value and appends the value
// of every `alert` key it finds under `name`. It recurses rather than indexing
// a fixed path because the rules reach the cluster two different ways: as a
// PrometheusRule object, and nested inside the `additionalPrometheusRulesMap`
// of a kube-prometheus-stack Application's Helm values. A path-anchored reader
// would silently return zero for whichever shape it was not written against.
func collectAlertNames(node any, out *[]string) {
	switch v := node.(type) {
	case map[string]any:
		if name, ok := v["alert"].(string); ok && name != "" {
			*out = append(*out, name)
		}
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			collectAlertNames(v[k], out)
		}
	case []any:
		for _, item := range v {
			collectAlertNames(item, out)
		}
	}
}

// CollectAlerts returns every alerting rule the render ships, across every
// environment. The environments are unioned, not intersected: an alert that
// only renders for homelab is still an alert an operator will be paged by.
func CollectAlerts(rendered map[string]map[string][]Doc) ([]ShippedAlert, error) {
	var alerts []ShippedAlert
	envs := make([]string, 0, len(rendered))
	for env := range rendered {
		envs = append(envs, env)
	}
	sort.Strings(envs)

	for _, env := range envs {
		charts := make([]string, 0, len(rendered[env]))
		for chart := range rendered[env] {
			charts = append(charts, chart)
		}
		sort.Strings(charts)

		for _, chart := range charts {
			for _, doc := range rendered[env][chart] {
				var names []string
				collectAlertNames(doc.Object, &names)

				// The Helm values of an ArgoCD Application are a YAML string,
				// so the rules inside them are opaque to the walk above until
				// the string is itself parsed.
				if values, ok := doc.Get("spec", "source", "helm", "values"); ok {
					if s, isString := values.(string); isString {
						var nested any
						if err := yaml.Unmarshal([]byte(s), &nested); err != nil {
							return nil, fmt.Errorf("%s/%s: %s: parsing spec.source.helm.values: %w",
								env, chart, doc.ID(), err)
						}
						collectAlertNames(nested, &names)
					}
				}

				for _, name := range names {
					alerts = append(alerts, ShippedAlert{
						Name: name, Env: env, Chart: chart, Owner: doc.ID(),
					})
				}
			}
		}
	}
	return alerts, nil
}

// RunbookTokens reads RunbooksDir and returns the set of identifier-shaped
// words it contains.
func RunbookTokens(repoRoot string) (map[string]bool, int, error) {
	dir := filepath.Join(repoRoot, filepath.FromSlash(RunbooksDir))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, 0, err
	}
	tokens := map[string]bool{}
	files := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, 0, err
		}
		files++
		for _, t := range runbookToken.FindAllString(string(data), -1) {
			tokens[t] = true
		}
	}
	return tokens, files, nil
}

// RunbookCoverage fails when a shipped alerting rule is not named in any
// runbook. It reads the render rather than the chart templates so it answers
// the question that matters — what an operator will actually be paged by —
// and so an alert added through a values file is covered the same as one
// added through a template.
func RunbookCoverage(repoRoot string, rendered map[string]map[string][]Doc) []Check {
	start := time.Now()

	alerts, err := CollectAlerts(rendered)
	if err != nil {
		return []Check{FailCheck("runbooks/coverage", start, "reading alerting rules from the render", err.Error())}
	}
	tokens, files, err := RunbookTokens(repoRoot)
	if err != nil {
		return []Check{FailCheck("runbooks/coverage", start, "reading "+RunbooksDir, err.Error())}
	}

	// A render that yields no alert at all is not a passing render, it is a
	// scan that saw nothing. Without this floor the check reports "every alert
	// has a runbook" when the collector stops matching the manifests, and a
	// gate that cannot go red is not a gate.
	if len(alerts) == 0 {
		return []Check{FailCheck("runbooks/coverage", start,
			"the render contains no alerting rule, so this check proves nothing. Either no chart ships alerts any more or the collector no longer matches how they are declared.",
			"0 alerting rules found across the render")}
	}
	if files == 0 {
		return []Check{FailCheck("runbooks/coverage", start,
			"no runbook was read, so every alert would be reported as uncovered for the wrong reason.",
			RunbooksDir+": 0 *.md files")}
	}

	// One alert renders once per environment; report it once, and name every
	// place it renders from so the author can find them all.
	sources := map[string][]string{}
	var names []string
	for _, a := range alerts {
		if _, seen := sources[a.Name]; !seen {
			names = append(names, a.Name)
		}
		sources[a.Name] = append(sources[a.Name], a.Source())
	}
	sort.Strings(names)

	var findings []string
	for _, name := range names {
		if tokens[name] {
			continue
		}
		findings = append(findings, fmt.Sprintf(
			"%s is not named in any %s/*.md (renders from %s)",
			name, RunbooksDir, strings.Join(sources[name], ", ")))
	}

	if len(findings) > 0 {
		return []Check{FailCheck("runbooks/coverage",
			start,
			fmt.Sprintf("every alerting rule must be named in a %s/*.md runbook. Add a section for the alert that says what the operator should check and what action resolves it; an alert with no runbook trains its reader to ignore the next one.", RunbooksDir),
			findings...)}
	}

	return []Check{PassCheck("runbooks/coverage", start,
		fmt.Sprintf("%d alerting rules, every one named in %s (%d runbooks)", len(names), RunbooksDir, files))}
}
