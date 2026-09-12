package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ryanmcafee/homelab/internal/config"
)

// RenderOptions configures a level-0 render pass. Every external tool goes
// through Runner so the whole pass is unit-testable offline.
type RenderOptions struct {
	// RepoRoot is the repository root (the directory holding Taskfile.yml).
	RepoRoot string
	// OutDir is required. Renders land at <OutDir>/<env>/<chart>.yaml and
	// per-env metadata at <OutDir>/<env>/_data.yaml.
	OutDir string
	// Envs defaults to the package-level Envs.
	Envs []Env
	// Charts optionally restricts the pass to these chart directory names.
	Charts []string
	// Parallel bounds concurrent helm invocations; defaults to runtime.NumCPU().
	Parallel int
	// SkipLint drops the lint/<env>/<chart> checks.
	SkipLint bool
	// SkipSchema drops the kubeconform/<env> and pluto/<env> checks.
	SkipSchema bool
	// SchemaDir holds vendored CRD JSON schemas; defaults to <RepoRoot>/tests/schemas.
	SchemaDir string
	// CacheDir is kubeconform's schema cache; defaults to DefaultCacheDir.
	CacheDir string
	// Runner defaults to ExecRunner{}.
	Runner Runner
}

// RenderOutput is the on-disk result of a render pass.
type RenderOutput struct {
	// Dir is OutDir.
	Dir string
	// Envs are the environments that were rendered.
	Envs []Env
	// Charts are the charts that were rendered.
	Charts []Chart
	// Files maps env -> chart -> rendered file path.
	Files map[string]map[string]string
}

// envRender is the per-environment state shared by every chart render.
type envRender struct {
	env Env
	// generated maps a two-stage chart name to the absolute path of its
	// config-export-generated values file.
	generated map[string]string
}

// applyDefaults fills unset options.
func (o *RenderOptions) applyDefaults() {
	if o.Parallel <= 0 {
		o.Parallel = runtime.NumCPU()
	}
	if len(o.Envs) == 0 {
		o.Envs = Envs
	}
	if o.Runner == nil {
		o.Runner = ExecRunner{}
	}
	if o.SchemaDir == "" {
		o.SchemaDir = filepath.Join(o.RepoRoot, "tests", "schemas")
	}
	if o.CacheDir == "" {
		o.CacheDir = DefaultCacheDir(o.RepoRoot)
	}
}

// Render renders, lints and schema-validates every selected chart for every
// selected environment. It never returns a Go error: every failure is a Check
// so that the JSON contract is the single output surface.
func Render(ctx context.Context, opts RenderOptions) (*RenderOutput, *Result) {
	start := time.Now()
	opts.applyDefaults()

	res := NewResult(0)
	out := &RenderOutput{Dir: opts.OutDir, Envs: opts.Envs, Files: map[string]map[string]string{}}

	setupFail := func(detail string, findings ...string) (*RenderOutput, *Result) {
		res.Add(FailCheck("render/setup", start, detail, findings...))
		res.Finalize(start)
		return out, res
	}

	if opts.OutDir == "" {
		return setupFail("RenderOptions.OutDir is required")
	}
	if opts.RepoRoot == "" {
		return setupFail("RenderOptions.RepoRoot is required")
	}

	charts, err := DiscoverCharts(opts.RepoRoot)
	if err != nil {
		return setupFail(fmt.Sprintf("discovering charts: %v", err))
	}
	charts, err = filterCharts(charts, opts.Charts)
	if err != nil {
		return setupFail(err.Error())
	}
	if len(charts) == 0 {
		return setupFail("no charts found under " + filepath.Join(opts.RepoRoot, "charts"))
	}
	out.Charts = charts

	k8sVersion, err := KubernetesVersion(opts.RepoRoot)
	if err != nil {
		return setupFail(fmt.Sprintf("resolving the target Kubernetes version: %v", err))
	}

	if _, err := opts.Runner.LookPath("helm"); err != nil {
		res.Add(FailCheck("render/helm", start, ToolMissingDetail("helm")))
		res.Finalize(start)
		return out, res
	}

	// Per-environment preparation is sequential: it resolves the config once
	// and writes _data.yaml plus any generated values the renders depend on.
	var prepared []envRender
	for _, env := range opts.Envs {
		er, check := prepareEnv(opts, env, k8sVersion)
		res.Add(check)
		if er == nil {
			continue
		}
		prepared = append(prepared, *er)
		out.Files[env.Name] = map[string]string{}
	}

	type job struct {
		er    envRender
		chart Chart
	}
	var jobs []job
	for _, er := range prepared {
		for _, c := range charts {
			jobs = append(jobs, job{er: er, chart: c})
		}
	}

	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)
	sem := make(chan struct{}, opts.Parallel)
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			checks, file := renderChart(ctx, opts, j.er, j.chart)
			mu.Lock()
			res.Add(checks...)
			if file != "" {
				out.Files[j.er.env.Name][j.chart.Name] = file
			}
			mu.Unlock()
		}(j)
	}
	wg.Wait()

	if opts.SkipSchema {
		for _, er := range prepared {
			res.Add(
				SkipCheck("kubeconform/"+er.env.Name, "schema validation disabled"),
				SkipCheck("pluto/"+er.env.Name, "schema validation disabled"),
			)
		}
	} else {
		var swg sync.WaitGroup
		for _, er := range prepared {
			swg.Add(1)
			go func(er envRender) {
				defer swg.Done()
				kc := kubeconformCheck(ctx, opts, er.env, k8sVersion, out.Files[er.env.Name])
				pl := plutoCheck(ctx, opts, er.env, k8sVersion)
				mu.Lock()
				res.Add(kc, pl)
				mu.Unlock()
			}(er)
		}
		swg.Wait()
	}

	res.Finalize(start)
	return out, res
}

// filterCharts restricts charts to names, erroring on an unknown name so a
// typo in --chart is reported instead of silently rendering nothing.
func filterCharts(charts []Chart, names []string) ([]Chart, error) {
	if len(names) == 0 {
		return charts, nil
	}
	byName := map[string]Chart{}
	for _, c := range charts {
		byName[c.Name] = c
	}
	var out []Chart
	var unknown []string
	for _, n := range names {
		c, ok := byName[n]
		if !ok {
			unknown = append(unknown, n)
			continue
		}
		out = append(out, c)
	}
	if len(unknown) > 0 {
		return nil, fmt.Errorf("unknown chart(s): %s", strings.Join(unknown, ", "))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// prepareEnv resolves the environment's config, writes <out>/<env>/_data.yaml
// and generates the two-stage values files. The returned envRender is nil when
// preparation failed.
func prepareEnv(opts RenderOptions, env Env, k8sVersion string) (*envRender, Check) {
	start := time.Now()
	name := fmt.Sprintf("render/%s/_config", env.Name)

	rc, err := resolveEnvConfig(opts.RepoRoot, env)
	if err != nil {
		return nil, FailCheck(name, start, fmt.Sprintf("resolving %s config: %v", env.Name, err))
	}

	envDir := filepath.Join(opts.OutDir, env.Name)
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		return nil, FailCheck(name, start, fmt.Sprintf("creating %s: %v", envDir, err))
	}

	domain := ""
	if v, ok := rc.Values["DOMAIN"]; ok {
		domain = v.Value
	}
	data := fmt.Sprintf("env: %s\ndomain: %s\nkubernetes_version: %s\n", env.Name, domain, k8sVersion)
	if err := os.WriteFile(filepath.Join(envDir, "_data.yaml"), []byte(data), 0o644); err != nil {
		return nil, FailCheck(name, start, fmt.Sprintf("writing _data.yaml: %v", err))
	}

	er := &envRender{env: env, generated: map[string]string{}}
	if env.TwoStage {
		for chart, format := range TwoStageCharts {
			tmpl := filepath.Join(opts.RepoRoot, "configuration", "templates", format+".tmpl")
			rendered, err := config.Export(rc, tmpl)
			if err != nil {
				return nil, FailCheck(name, start, fmt.Sprintf("exporting %s values for %s: %v", format, chart, err))
			}
			dest := filepath.Join(envDir, "_values", chart+".yaml")
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return nil, FailCheck(name, start, fmt.Sprintf("creating %s: %v", filepath.Dir(dest), err))
			}
			if err := os.WriteFile(dest, []byte(rendered), 0o644); err != nil {
				return nil, FailCheck(name, start, fmt.Sprintf("writing %s: %v", dest, err))
			}
			er.generated[chart] = dest
		}
	}

	detail := fmt.Sprintf("domain=%s kubernetes=%s", domain, k8sVersion)
	if len(er.generated) > 0 {
		detail += fmt.Sprintf(" two-stage values=%d", len(er.generated))
	}
	return er, PassCheck(name, start, detail)
}

// resolveEnvConfig runs the config pipeline for one level-0 environment. It
// deliberately reads env.EnvFile (the PII-free example for homelab) and never
// configuration/environments/homelab.yaml.
func resolveEnvConfig(repoRoot string, env Env) (*config.ResolvedConfig, error) {
	root := filepath.Join(repoRoot, "configuration")

	schema, err := config.LoadSchemaDir(filepath.Join(root, "schema"))
	if err != nil {
		return nil, fmt.Errorf("loading schemas: %w", err)
	}
	versions, err := config.LoadVersions(filepath.Join(root, "versions.yaml"))
	if err != nil {
		return nil, fmt.Errorf("loading versions: %w", err)
	}
	defaults, err := config.LoadEnvironment(filepath.Join(root, "environments", "defaults.yaml"))
	if err != nil {
		return nil, fmt.Errorf("loading defaults: %w", err)
	}
	values, err := config.LoadEnvironment(filepath.Join(repoRoot, env.EnvFile))
	if err != nil {
		return nil, fmt.Errorf("loading %s: %w", env.EnvFile, err)
	}
	return config.Eval(schema, versions, env.ConfigSet, defaults, values)
}

// valuesArgs builds the -f arguments for a (chart, env) pair and a detail
// string describing which values files were used.
func valuesArgs(opts RenderOptions, er envRender, c Chart) ([]string, string) {
	if _, twoStage := TwoStageCharts[c.Name]; twoStage && er.env.TwoStage {
		base := filepath.ToSlash(filepath.Join(c.Path, "values.yaml"))
		gen := er.generated[c.Name]
		return []string{"-f", base, "-f", gen},
			fmt.Sprintf("values: %s, %s (generated by config export)", base, gen)
	}

	files := ValuesFiles(opts.RepoRoot, c, er.env.Name)
	args := make([]string, 0, len(files)*2)
	for _, f := range files {
		args = append(args, "-f", f)
	}
	detail := "values: " + strings.Join(files, ", ")
	envValues := "values-" + er.env.Name + ".yaml"
	if !containsSuffix(files, "/"+envValues) {
		detail += "; " + envValues + " missing"
	}
	return args, detail
}

func containsSuffix(list []string, suffix string) bool {
	for _, s := range list {
		if strings.HasSuffix(s, suffix) {
			return true
		}
	}
	return false
}

// renderChart runs helm template (and optionally helm lint) for one
// (env, chart) pair and returns its checks plus the rendered file path.
func renderChart(ctx context.Context, opts RenderOptions, er envRender, c Chart) ([]Check, string) {
	name := fmt.Sprintf("render/%s/%s", er.env.Name, c.Name)
	start := time.Now()

	vargs, detail := valuesArgs(opts, er, c)
	args := append([]string{"template", c.Name, c.Path, "--include-crds"}, vargs...)

	stdout, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "helm", args...)
	if err != nil {
		return []Check{FailCheck(name, start,
			fmt.Sprintf("helm template failed (%v)", err),
			outputLines(stderr, stdout)...)}, ""
	}

	dest := RenderedFile(opts.OutDir, er.env.Name, c.Name)
	if err := os.WriteFile(dest, stdout, 0o644); err != nil {
		return []Check{FailCheck(name, start, fmt.Sprintf("writing %s: %v", dest, err))}, ""
	}

	checks := []Check{PassCheck(name, start, detail)}
	if !opts.SkipLint {
		checks = append(checks, lintChart(ctx, opts, er, c, vargs))
	}
	return checks, dest
}

// lintChart runs helm lint. Only [ERROR] lines (or a non-zero exit) fail the
// check; [WARNING] and [INFO] lines are informational.
func lintChart(ctx context.Context, opts RenderOptions, er envRender, c Chart, vargs []string) Check {
	name := fmt.Sprintf("lint/%s/%s", er.env.Name, c.Name)
	start := time.Now()

	args := append([]string{"lint", c.Path}, vargs...)
	stdout, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "helm", args...)

	combined := string(stdout) + "\n" + string(stderr)
	var errors []string
	for _, line := range strings.Split(combined, "\n") {
		if strings.Contains(line, "[ERROR]") {
			errors = append(errors, strings.TrimSpace(line))
		}
	}
	if len(errors) > 0 {
		return FailCheck(name, start, fmt.Sprintf("helm lint reported %d error(s)", len(errors)), errors...)
	}
	if err != nil {
		return FailCheck(name, start, fmt.Sprintf("helm lint failed (%v)", err), outputLines(stderr, stdout)...)
	}

	warnings := strings.Count(combined, "[WARNING]")
	if warnings > 0 {
		return PassCheck(name, start, fmt.Sprintf("%d warning(s)", warnings))
	}
	return PassCheck(name, start, "")
}

// kubeconformResult mirrors kubeconform's `-output json` document.
type kubeconformResult struct {
	Resources []struct {
		Filename string `json:"filename"`
		Kind     string `json:"kind"`
		Name     string `json:"name"`
		Version  string `json:"version"`
		Status   string `json:"status"`
		Msg      string `json:"msg"`
	} `json:"resources"`
	Summary struct {
		Valid   int `json:"valid"`
		Invalid int `json:"invalid"`
		Errors  int `json:"errors"`
		Skipped int `json:"skipped"`
	} `json:"summary"`
}

// kubeconformCheck validates every rendered file for an env against the
// upstream schemas plus the vendored CRD schemas in SchemaDir. There is
// deliberately no -skip: an unknown kind is a missing schema, not a pass.
func kubeconformCheck(ctx context.Context, opts RenderOptions, env Env, k8sVersion string, files map[string]string) Check {
	name := "kubeconform/" + env.Name
	start := time.Now()

	if _, err := opts.Runner.LookPath("kubeconform"); err != nil {
		return FailCheck(name, start, ToolMissingDetail("kubeconform"))
	}
	paths := sortedValues(files)
	if len(paths) == 0 {
		return SkipCheck(name, "no rendered files for "+env.Name)
	}
	if err := os.MkdirAll(opts.CacheDir, 0o755); err != nil {
		return FailCheck(name, start, fmt.Sprintf("creating kubeconform cache %s: %v", opts.CacheDir, err))
	}

	args := []string{
		"-strict",
		"-summary",
		"-output", "json",
		"-kubernetes-version", k8sVersion,
		"-cache", opts.CacheDir,
		"-schema-location", "default",
		"-schema-location", filepath.Join(opts.SchemaDir, "{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"),
	}
	args = append(args, paths...)

	stdout, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "kubeconform", args...)

	var parsed kubeconformResult
	if jerr := json.Unmarshal(stdout, &parsed); jerr != nil {
		detail := fmt.Sprintf("parsing kubeconform output: %v", jerr)
		if err != nil {
			detail = fmt.Sprintf("kubeconform failed (%v)", err)
		}
		return FailCheck(name, start, detail, outputLines(stderr, stdout)...)
	}

	var findings []string
	for _, r := range parsed.Resources {
		if r.Status != "statusError" && r.Status != "statusInvalid" {
			continue
		}
		// The apiVersion is appended so a failure names the exact
		// group/version whose schema has to be vendored into SchemaDir.
		findings = append(findings, fmt.Sprintf("%s: %s/%s: %s (apiVersion %s)",
			shortPath(opts.OutDir, r.Filename), r.Kind, r.Name, r.Msg, r.Version))
	}
	detail := fmt.Sprintf("%d valid, %d invalid, %d errors, %d skipped",
		parsed.Summary.Valid, parsed.Summary.Invalid, parsed.Summary.Errors, parsed.Summary.Skipped)

	if len(findings) > 0 {
		return FailCheck(name, start, detail, findings...)
	}
	if err != nil {
		return FailCheck(name, start, detail+fmt.Sprintf(" (kubeconform exited %v)", err), outputLines(stderr)...)
	}
	return PassCheck(name, start, detail)
}

// plutoOutput mirrors pluto's `-o json` document.
type plutoOutput struct {
	Items []struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
		FilePath  string `json:"filePath"`
		API       struct {
			Version        string `json:"version"`
			Kind           string `json:"kind"`
			DeprecatedIn   string `json:"deprecated-in"`
			RemovedIn      string `json:"removed-in"`
			ReplacementAPI string `json:"replacement-api"`
		} `json:"api"`
		Deprecated bool `json:"deprecated"`
		Removed    bool `json:"removed"`
	} `json:"items"`
}

// plutoCheck scans an env's rendered directory for deprecated or removed APIs
// against the repo's target Kubernetes version.
func plutoCheck(ctx context.Context, opts RenderOptions, env Env, k8sVersion string) Check {
	name := "pluto/" + env.Name
	start := time.Now()

	if _, err := opts.Runner.LookPath("pluto"); err != nil {
		return FailCheck(name, start, ToolMissingDetail("pluto"))
	}

	envDir := filepath.Join(opts.OutDir, env.Name)
	args := []string{
		"detect-files",
		"-d", envDir,
		"--target-versions", "k8s=v" + k8sVersion,
		"-o", "json",
	}
	stdout, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "pluto", args...)

	// mise puts a shim on PATH for every tool it knows about, installed or not,
	// so LookPath succeeds and a missing pluto only surfaces as a failed run.
	// Report it as the missing tool it is rather than a raw exit status.
	if err != nil && isMiseShimMiss(stderr) {
		return FailCheck(name, start, ToolMissingDetail("pluto"), outputLines(stderr)...)
	}

	var parsed plutoOutput
	if jerr := json.Unmarshal(stdout, &parsed); jerr != nil {
		detail := fmt.Sprintf("parsing pluto output: %v", jerr)
		if err != nil {
			detail = fmt.Sprintf("pluto failed (%v)", err)
		}
		return FailCheck(name, start, detail, outputLines(stderr, stdout)...)
	}

	var findings []string
	for _, it := range parsed.Items {
		if !it.Deprecated && !it.Removed {
			continue
		}
		state := "deprecated in " + orNA(it.API.DeprecatedIn)
		if it.Removed {
			state = "removed in " + orNA(it.API.RemovedIn)
		}
		findings = append(findings, fmt.Sprintf("%s: %s %s/%s: %s; use %s",
			shortPath(opts.OutDir, it.FilePath), it.API.Version, it.API.Kind, it.Name,
			state, orNA(it.API.ReplacementAPI)))
	}
	sort.Strings(findings)

	if len(findings) > 0 {
		return FailCheck(name, start,
			fmt.Sprintf("%d deprecated or removed API(s) for k8s v%s", len(findings), k8sVersion), findings...)
	}
	if err != nil {
		return FailCheck(name, start, fmt.Sprintf("pluto exited %v", err), outputLines(stderr)...)
	}
	return PassCheck(name, start, "no deprecated APIs for k8s v"+k8sVersion)
}

// isMiseShimMiss reports whether stderr is mise telling us a shim resolved but
// no version of the tool is installed. That is a missing tool, not a tool
// failure, and the two need different remediation.
func isMiseShimMiss(stderr []byte) bool {
	s := string(stderr)
	return strings.Contains(s, "No version is set for shim") ||
		strings.Contains(s, "is not installed")
}

func orNA(s string) string {
	if strings.TrimSpace(s) == "" {
		return "n/a"
	}
	return s
}

// outputLines turns tool output into findings, trimming blanks and keeping the
// first maxFindingLines lines so a JSON result stays readable.
func outputLines(chunks ...[]byte) []string {
	const maxFindingLines = 40
	var out []string
	for _, chunk := range chunks {
		for _, line := range strings.Split(string(chunk), "\n") {
			if line = strings.TrimRight(line, "\r \t"); line == "" {
				continue
			}
			out = append(out, line)
			if len(out) == maxFindingLines {
				return append(out, "... truncated")
			}
		}
	}
	return out
}

// shortPath trims the render directory prefix so findings read as
// "<env>/<chart>.yaml" instead of a long temp path.
func shortPath(outDir, path string) string {
	if rel, err := filepath.Rel(outDir, path); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	return path
}

func sortedValues(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}
