package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Restrict Helm's path language to a canonical subset. Escaped key characters
// and signed/zero-padded array indexes can alias otherwise distinct names.
// Dotted identifier keys and canonical nonnegative indexes need no unescaping.
var openClawParameterPath = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*(\[(0|[1-9][0-9]*)\])*(\.[A-Za-z_][A-Za-z0-9_-]*(\[(0|[1-9][0-9]*)\])*)*$`)

// OpenClawCheck checks the rendered Application, not a second set of test values.
// The local probe uses Helm's own parameter parser without fetching any chart.
// Upstream adds a full pinned-chart render and effective RBAC validation.
func OpenClawCheck(ctx context.Context, runner Runner, env string, rendered map[string][]Doc, upstream bool, kubeVersions ...string) Check {
	start := time.Now()
	runner = pinTools(ctx, runner, ".", "helm")
	name := "gitops/" + env + "/openclaw-intent"
	if upstream {
		name = "upgrade/" + env + "/openclaw-rbac"
	}
	fail := func(err error) Check { return FailCheck(name, start, err.Error()) }
	src, instance, present, err := openClawSource(rendered)
	if err != nil {
		return fail(err)
	}
	docCount := 0
	for _, docs := range rendered {
		docCount += len(docs)
	}
	if docCount == 0 {
		return fail(fmt.Errorf("no parsed manifests available for OpenClaw verification"))
	}
	if !present {
		return PassCheck(name, start, "unchanged: OpenClaw is not enabled in this render")
	}
	dir, err := os.MkdirTemp("", "homelab-openclaw-")
	if err != nil {
		return fail(err)
	}
	defer os.RemoveAll(dir)
	values, err := openClawValues(ctx, runner, src, dir)
	if err != nil {
		return fail(err)
	}
	if err = validateOpenClawIntent(values, src.Namespace, instance); err != nil {
		return fail(err)
	}
	if upstream {
		kubeVersion := ""
		if len(kubeVersions) > 0 {
			kubeVersion = kubeVersions[0]
		}
		data, renderErr := renderUpstream(ctx, runner, dir, src, kubeVersion, filepath.Join(dir, "upstream"))
		if renderErr != nil {
			return fail(fmt.Errorf("OpenClaw full chart render failed: %s %s", renderErr.detail, strings.Join(renderErr.lines, "; ")))
		}
		if err = validateOpenClawRBAC(data, src.Namespace, instance); err != nil {
			return fail(err)
		}
	}
	return PassCheck(name, start, "unchanged: OpenClaw effective values satisfy namespace and aggregation policy"+map[bool]string{true: "; full pinned chart RBAC passed", false: " (offline)"}[upstream])
}

func openClawSource(rendered map[string][]Doc) (ChartSource, string, bool, error) {
	var operator, instance []Doc
	for _, chart := range sortedKeys(rendered) {
		for _, d := range rendered[chart] {
			if d.Kind() != "Application" {
				continue
			}
			if d.Name() == "openclaw-operator" || d.GetString("spec", "source", "chart") == "openclaw-operator" {
				operator = append(operator, d)
			}
			if d.Name() == "openclaw" || d.GetString("spec", "source", "path") == "charts/openclaw" {
				instance = append(instance, d)
			}
		}
	}
	var zero ChartSource
	if len(operator) == 0 && len(instance) == 0 {
		return zero, "", false, nil
	}
	bad := func(s string) (ChartSource, string, bool, error) {
		return zero, "", true, fmt.Errorf("OpenClaw Application: %s", s)
	}
	if len(operator) != 1 || len(instance) != 1 {
		return bad("require exactly one operator and one instance Application")
	}
	d := operator[0]
	if _, ok := d.Get("spec", "sources"); ok {
		return bad("multi-source operator Applications are unsupported; use a single pinned chart source")
	}
	raw, ok := d.Get("spec", "source")
	if !ok {
		return bad("missing source")
	}
	source, ok := raw.(map[string]any)
	if !ok {
		return bad("source must be an object")
	}
	for _, key := range []string{"repoURL", "chart", "targetRevision"} {
		s, ok := source[key].(string)
		if !ok || strings.TrimSpace(s) == "" {
			return bad("missing/string required: " + key)
		}
	}
	if source["path"] != nil || source["plugin"] != nil {
		return bad("operator must use only a Helm chart source")
	}
	if source["chart"] != "openclaw-operator" {
		return bad("unexpected operator chart")
	}
	if !regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`).MatchString(source["targetRevision"].(string)) {
		return bad("targetRevision must be an exact chart version")
	}
	helm, ok := source["helm"].(map[string]any)
	if !ok {
		return bad("helm must be an object")
	}
	for key, v := range helm {
		switch key {
		case "values", "releaseName":
			if _, ok := v.(string); !ok {
				return bad(key + " must be a string")
			}
		case "valuesObject":
			if _, ok := v.(map[string]any); !ok {
				return bad("valuesObject must be an object")
			}
		case "skipCrds":
			if _, ok := v.(bool); !ok {
				return bad("skipCrds must be boolean")
			}
		case "parameters":
			ps, ok := v.([]any)
			if !ok {
				return bad("parameters must be an array")
			}
			var parameterNames []string
			for _, p := range ps {
				m, ok := p.(map[string]any)
				if !ok {
					return bad("parameter must be an object")
				}
				n, nok := m["name"].(string)
				_, vok := m["value"].(string)
				if !nok || n == "" || !vok {
					return bad("parameter name/value must be strings")
				}
				if !openClawParameterPath.MatchString(n) {
					return bad("noncanonical Helm parameter path " + n + "; use dotted identifier keys and unsigned indexes without leading zeros, or move this value to valuesObject")
				}
				// Argo CD stores parameters in maps; overlapping assignments have
				// no stable order. Never prove one ordering and deploy another.
				for _, previous := range parameterNames {
					if previous == n || strings.HasPrefix(previous, n+".") || strings.HasPrefix(previous, n+"[") || strings.HasPrefix(n, previous+".") || strings.HasPrefix(n, previous+"[") {
						return bad("overlapping Helm parameters have undefined Argo CD ordering: " + previous + " and " + n)
					}
				}
				parameterNames = append(parameterNames, n)
				if b, exists := m["forceString"]; exists {
					if _, ok := b.(bool); !ok {
						return bad("forceString must be boolean")
					}
				}
			}
		default:
			return bad("unsupported Helm option " + key + "; extend the verifier before using it (external valueFiles/fileParameters cannot be verified offline)")
		}
	}
	ns := instance[0].GetString("spec", "destination", "namespace")
	src := sourceFromMap(d.Name(), d.Chart, d.GetString("spec", "destination", "namespace"), source)
	validNS := regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	opNS, _ := d.Get("spec", "destination", "namespace")
	instanceNS, _ := instance[0].Get("spec", "destination", "namespace")
	_, opString := opNS.(string)
	_, instanceString := instanceNS.(string)
	if !opString || !instanceString || len(src.Namespace) > 63 || len(ns) > 63 || !validNS.MatchString(src.Namespace) || !validNS.MatchString(ns) || src.Namespace == ns {
		return bad("operator and instance destination namespaces must be nonempty and distinct")
	}
	return src, ns, true, nil
}

func openClawValues(ctx context.Context, runner Runner, src ChartSource, dir string) (map[string]any, error) {
	chart := filepath.Join(dir, "probe")
	if err := os.MkdirAll(filepath.Join(chart, "templates"), 0755); err != nil {
		return nil, err
	}
	for path, body := range map[string]string{"Chart.yaml": "apiVersion: v2\nname: effective-values\nversion: 0.1.0\n", "templates/values.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: effective-values\ndata:\n  values: {{ .Values | toJson | quote }}\n"} {
		if err := os.WriteFile(filepath.Join(chart, path), []byte(body), 0600); err != nil {
			return nil, err
		}
	}
	files, err := upstreamValueFiles(src, dir)
	if err != nil {
		return nil, err
	}
	probe := src
	probe.RepoURL = "oci://unused"
	probe.TargetRevision = ""
	args := upstreamArgs(probe, "", files)
	args[2] = chart
	out, stderr, err := runner.Run(ctx, dir, "helm", args...)
	if err != nil {
		return nil, fmt.Errorf("resolving effective OpenClaw values: %v: %s", err, stderr)
	}
	docs, err := ParseMultiDoc("", "", out)
	if err != nil {
		return nil, err
	}
	if len(docs) != 1 {
		return nil, fmt.Errorf("effective values probe returned %d documents, expected one", len(docs))
	}
	var values map[string]any
	err = yaml.Unmarshal([]byte(docs[0].GetString("data", "values")), &values)
	if err != nil || values == nil {
		return nil, fmt.Errorf("cannot parse effective OpenClaw values: %v", err)
	}
	return values, nil
}

func validateOpenClawIntent(values map[string]any, operator, instance string) error {
	watch, ok := values["watchNamespaces"].([]any)
	if !ok || len(watch) != 1 || watch[0] != instance || instance == "" || instance == operator {
		return fmt.Errorf("OpenClaw watchNamespaces must contain exactly configured instance namespace %q", instance)
	}
	rbac, ok := values["rbac"].(map[string]any)
	if !ok || rbac["aggregateToDefaultRoles"] != false {
		return fmt.Errorf("OpenClaw requires rbac.aggregateToDefaultRoles=false")
	}
	return nil
}
