package verify

import (
	"bytes"
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

	"gopkg.in/yaml.v3"

	"github.com/ryanmcafee/homelab/internal/config"
)

// RenderOptions configures a level-0 render pass. Every external tool goes
// through Runner so the whole pass is unit-testable offline.
type RenderOptions struct {
	// RepoRoot is the repository root (the directory holding Taskfile.yml).
	RepoRoot string
	// OutDir is required. Renders land at <OutDir>/<env>/<chart>.yaml and
	// per-env metadata at <OutDir>/<env>/_data.yaml. Values a child inherits
	// from its parent Application are written to
	// <OutDir>/<env>/_inherited/<chart>.yaml, and parents rendered only to
	// extract those values (see Charts) to <OutDir>/<env>/_parents/<chart>.yaml.
	OutDir string
	// Envs defaults to the package-level Envs.
	Envs []Env
	// Charts optionally restricts the pass to these chart directory names.
	// Parents the selection leaves out are still rendered when a selected
	// chart inherits values from them, but produce no checks and no Files.
	Charts []string
	// Parallel bounds concurrent helm invocations; defaults to runtime.NumCPU().
	Parallel int
	// SkipLint drops the lint/<env>/<chart> checks.
	SkipLint bool
	// SkipSchema does not run kubeconform or pluto and reports them as skipped
	// checks, so a --skip-schema run still accounts for them.
	SkipSchema bool
	// OmitSchemaChecks implies SkipSchema and emits no check at all, for
	// callers whose contract does not include schema validation (verify
	// snapshot). Without it a skip check would appear that no flag explains.
	OmitSchemaChecks bool
	// SchemaDir holds vendored CRD JSON schemas; defaults to <RepoRoot>/tests/schemas.
	SchemaDir string
	// CacheDir is kubeconform's schema cache root; defaults to DefaultCacheDir.
	// Each env gets its own subdirectory so concurrent kubeconform processes
	// never write the same cache entry.
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

// inheritedValues is one chart's parent-provided values: the helm.valuesObject
// of the Application that deploys it, extracted from the parent's render.
type inheritedValues struct {
	// path is the absolute path of the extracted values file.
	path string
	// body is the marshalled valuesObject, kept so a second Application
	// handing the same chart different values can be detected.
	body []byte
	// producer names the Application (and its chart) the values came from.
	producer string
}

// envRender is the per-environment state shared by every chart render. It is
// passed by pointer: the inheritance maps are filled between render waves and
// read by the renders of the next wave.
type envRender struct {
	env Env
	// domain is the env's resolved DOMAIN. Two-stage envs hand it to the
	// gitops chart with --set, mirroring the Terraform root Application.
	domain string
	// generated maps a two-stage chart name to the absolute path of its
	// config-export-generated values file.
	generated map[string]string
	// inherited maps a chart name to the values its parent Application
	// passes through helm.valuesObject. ArgoCD applies valuesObject on top of
	// valueFiles, so the file is appended after the chart's own values.
	inherited map[string]inheritedValues
	// parentFiles maps a parent chart rendered in the current wave to its
	// output file, whether a normal render or an inherit-only one. It is
	// consumed (and cleared) by collectInherited after each parent wave.
	parentFiles map[string]string
	// inheritFindings and inheritProblems feed the render/<env>/_inherit
	// check: a problem is one conflict or one failed inherit-only render,
	// which may contribute several finding lines.
	inheritFindings []string
	inheritProblems int
	// inheritSpent is the time collectInherited took, so the _inherit check
	// reports the extraction cost rather than the surrounding renders.
	inheritSpent time.Duration
}

// renderJob is one (env, chart) render. inheritOnly renders are parents the
// --chart filter left out: their output only feeds inheritance and produces
// neither checks nor RenderOutput.Files entries.
type renderJob struct {
	er          *envRender
	chart       Chart
	inheritOnly bool
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
//
// Charts render in waves so that a parent's Applications are on disk before
// the children they hand values to: gitops first, then the other parents,
// then everything else. After each parent wave the helm.valuesObject of every
// rendered Application is extracted for the chart it points at (see
// collectInherited), mirroring ArgoCD's valueFiles < valuesObject precedence.
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

	all, err := DiscoverCharts(opts.RepoRoot)
	if err != nil {
		return setupFail(fmt.Sprintf("discovering charts: %v", err))
	}
	charts, err := filterCharts(all, opts.Charts)
	if err != nil {
		return setupFail(err.Error())
	}
	if len(charts) == 0 {
		return setupFail("no charts found under " + filepath.Join(opts.RepoRoot, "charts"))
	}
	out.Charts = charts
	inheritOnly := inheritOnlyParents(all, charts, opts.Charts)

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
	var prepared []*envRender
	for _, env := range opts.Envs {
		er, check := prepareEnv(opts, env, k8sVersion)
		res.Add(check)
		if er == nil {
			// Nothing can render for this env. Emit the checks an agent would
			// look for by name as skips, so a missing name never reads as
			// "this check does not exist".
			res.Add(skippedEnvChecks(opts, env, charts)...)
			continue
		}
		prepared = append(prepared, er)
		out.Files[env.Name] = map[string]string{}
	}

	var mu sync.Mutex
	// One semaphore for the whole pass, so --parallel caps external processes
	// across waves and the schema phase alike.
	sem := make(chan struct{}, opts.Parallel)
	for wave := 0; wave <= lastWave; wave++ {
		var jobs []renderJob
		for _, er := range prepared {
			for _, c := range charts {
				if renderWave(c) == wave {
					jobs = append(jobs, renderJob{er: er, chart: c})
				}
			}
			for _, c := range inheritOnly {
				if renderWave(c) == wave {
					jobs = append(jobs, renderJob{er: er, chart: c, inheritOnly: true})
				}
			}
		}
		runWave(ctx, opts, jobs, sem, &mu, res, out)
		if ctx.Err() != nil {
			res.Add(FailCheck("render/cancelled", start, fmt.Sprintf("run cancelled before completion: %v", ctx.Err())))
			res.Finalize(start)
			return out, res
		}
		if wave < lastWave {
			for _, er := range prepared {
				collectInherited(opts, er)
			}
		}
		if wave == lastWave-1 {
			// Every producer has rendered by now; the last wave only consumes.
			for _, er := range prepared {
				res.Add(inheritCheck(er))
			}
		}
	}

	switch {
	case opts.OmitSchemaChecks:
		// Deliberately silent: schema validation is not part of this caller's
		// contract, so it gets no check of any status.
	case opts.SkipSchema:
		for _, er := range prepared {
			res.Add(
				SkipCheck("kubeconform/"+er.env.Name, "schema validation disabled"),
				SkipCheck("pluto/"+er.env.Name, "schema validation disabled"),
			)
		}
	default:
		var swg sync.WaitGroup
		for _, er := range prepared {
			swg.Add(1)
			go func(er *envRender) {
				defer swg.Done()
				files := out.Files[er.env.Name]
				// Reusing the render pool's semaphore means --parallel caps
				// external processes across the whole pass, not per env. The
				// render pool has fully drained by this point.
				kc := kubeconformCheck(ctx, opts, er.env, k8sVersion, files, sem)
				pl := plutoCheck(ctx, opts, er.env, k8sVersion, files, sem)
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

// lastWave is the index of the final render wave (the non-parent charts).
const lastWave = 2

// renderWave places a chart in its render wave: gitops (wave 0) deploys the
// other parents, which (wave 1) deploy every remaining chart (wave 2). A
// chart only ever inherits values from an earlier wave.
func renderWave(c Chart) int {
	switch {
	case c.Name == "gitops":
		return 0
	case c.Parent:
		return 1
	default:
		return lastWave
	}
}

// inheritOnlyParents lists the parents a --chart filter left out that a
// selected chart may inherit values from, directly or through another
// parent. Only gitops, addons and applications emit path-based Applications:
// gitops deploys the other parents, addons and applications deploy the
// children. A child selection therefore needs addons and applications, and
// gitops as well, because addons and applications may themselves inherit
// from gitops and would otherwise render without the values they hand down.
// bootstrap deploys no chart from this repository, so it is never needed on
// another chart's behalf. Without a filter there is nothing to add.
func inheritOnlyParents(all, selected []Chart, filter []string) []Chart {
	if len(filter) == 0 {
		return nil
	}
	chosen := map[string]bool{}
	needGitops, needChildParents := false, false
	for _, c := range selected {
		chosen[c.Name] = true
		switch {
		case c.Name == "gitops":
		case c.Parent:
			needGitops = true
		default:
			needChildParents = true
		}
	}
	if needChildParents {
		needGitops = true
	}
	var out []Chart
	for _, c := range all {
		if chosen[c.Name] {
			continue
		}
		if (c.Name == "gitops" && needGitops) ||
			((c.Name == "addons" || c.Name == "applications") && needChildParents) {
			out = append(out, c)
		}
	}
	return out
}

// runWave renders one wave through the bounded worker pool and returns once
// every dispatched job has finished. A cancelled context stops dispatching
// instead of draining the queue; the caller checks ctx afterwards.
func runWave(ctx context.Context, opts RenderOptions, jobs []renderJob, sem chan struct{}, mu *sync.Mutex, res *Result, out *RenderOutput) {
	var wg sync.WaitGroup
	// Inherit-only failures land here in goroutine completion order and are
	// appended per env in chart order after the wave, so the findings of
	// render/<env>/_inherit read the same on every run.
	inheritOnlyFindings := map[*envRender]map[string][]string{}
	for _, j := range jobs {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		go func(j renderJob) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if ctx.Err() != nil {
				return
			}

			if j.inheritOnly {
				file, findings := renderParentForInheritance(ctx, opts, j.er, j.chart)
				mu.Lock()
				if file != "" {
					j.er.parentFiles[j.chart.Name] = file
				}
				if len(findings) > 0 {
					if inheritOnlyFindings[j.er] == nil {
						inheritOnlyFindings[j.er] = map[string][]string{}
					}
					inheritOnlyFindings[j.er][j.chart.Name] = findings
				}
				mu.Unlock()
				return
			}

			checks, file := renderChart(ctx, opts, j.er, j.chart)
			mu.Lock()
			res.Add(checks...)
			if file != "" {
				out.Files[j.er.env.Name][j.chart.Name] = file
				if j.chart.Parent {
					j.er.parentFiles[j.chart.Name] = file
				}
			}
			mu.Unlock()
		}(j)
	}
	wg.Wait()
	for er, byChart := range inheritOnlyFindings {
		charts := make([]string, 0, len(byChart))
		for name := range byChart {
			charts = append(charts, name)
		}
		sort.Strings(charts)
		for _, name := range charts {
			er.inheritProblems++
			er.inheritFindings = append(er.inheritFindings, byChart[name]...)
		}
	}
}

// collectInherited extracts helm.valuesObject from every Application in the
// parents rendered by the wave that just finished and writes each one to
// <OutDir>/<env>/_inherited/<chart>.yaml, keyed by the Application's
// spec.source.path. The next wave appends that file to the child's values.
//
// Two Applications may deploy the same chart only if they hand it the same
// values; anything else is a real GitOps ambiguity and is reported through
// the render/<env>/_inherit check rather than silently picking one.
func collectInherited(opts RenderOptions, er *envRender) {
	start := time.Now()
	defer func() { er.inheritSpent += time.Since(start) }()

	problem := func(findings ...string) {
		er.inheritProblems++
		er.inheritFindings = append(er.inheritFindings, findings...)
	}

	for _, parent := range sortedKeys(er.parentFiles) {
		file := er.parentFiles[parent]
		data, err := os.ReadFile(file)
		if err != nil {
			problem(fmt.Sprintf("%s: reading %s: %v", parent, shortPath(opts.OutDir, file), err))
			continue
		}
		docs, err := ParseMultiDoc(parent, er.env.Name, data)
		if err != nil {
			problem(fmt.Sprintf("%s: parsing rendered output: %v", parent, err))
			continue
		}
		for _, d := range docs {
			if !isApplication(d) {
				continue
			}
			for _, src := range appSources(d) {
				chart, ok := chartNameFromPath(src.GetString("path"))
				if !ok {
					continue
				}
				vo, ok := src.Get("helm", "valuesObject")
				if !ok {
					continue
				}
				producer := fmt.Sprintf("Application %s (%s)", d.Name(), parent)
				m, ok := vo.(map[string]any)
				if !ok {
					problem(fmt.Sprintf("%s: %s: helm.valuesObject is not a mapping", chart, producer))
					continue
				}
				body, err := yaml.Marshal(m)
				if err != nil {
					problem(fmt.Sprintf("%s: %s: marshalling helm.valuesObject: %v", chart, producer, err))
					continue
				}
				if prev, seen := er.inherited[chart]; seen {
					if !bytes.Equal(prev.body, body) {
						problem(fmt.Sprintf("%s: helm.valuesObject from %s differs from %s", chart, producer, prev.producer))
					}
					continue
				}
				dest := filepath.Join(opts.OutDir, er.env.Name, "_inherited", chart+".yaml")
				if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
					problem(fmt.Sprintf("%s: creating %s: %v", chart, filepath.Dir(dest), err))
					continue
				}
				if err := os.WriteFile(dest, body, 0o644); err != nil {
					problem(fmt.Sprintf("%s: writing %s: %v", chart, shortPath(opts.OutDir, dest), err))
					continue
				}
				er.inherited[chart] = inheritedValues{path: dest, body: body, producer: producer}
			}
		}
	}
	er.parentFiles = map[string]string{}
}

// inheritCheck reports how many charts received parent values in an env and
// fails on any conflict or failed inherit-only render.
func inheritCheck(er *envRender) Check {
	c := Check{
		Name:       fmt.Sprintf("render/%s/_inherit", er.env.Name),
		Status:     StatusPass,
		DurationMS: er.inheritSpent.Milliseconds(),
		Detail:     fmt.Sprintf("values inherited from parent Applications: %d", len(er.inherited)),
	}
	if er.inheritProblems > 0 {
		c.Status = StatusFail
		c.Detail += fmt.Sprintf("; %d problem(s)", er.inheritProblems)
		c.Findings = er.inheritFindings
	}
	return c
}

// skippedEnvChecks returns the full set of check names an env would have
// produced, as skips. It runs when config resolution failed, so that an agent
// matching on render/<env>/<chart> or kubeconform/<env> finds the name present
// and explicitly not run, rather than absent.
func skippedEnvChecks(opts RenderOptions, env Env, charts []Chart) []Check {
	const detail = "config resolution failed"
	out := []Check{SkipCheck(fmt.Sprintf("render/%s/_inherit", env.Name), detail)}
	for _, c := range charts {
		out = append(out, SkipCheck(fmt.Sprintf("render/%s/%s", env.Name, c.Name), detail))
		if !opts.SkipLint {
			out = append(out, SkipCheck(fmt.Sprintf("lint/%s/%s", env.Name, c.Name), detail))
		}
	}
	if !opts.OmitSchemaChecks {
		out = append(out,
			SkipCheck("kubeconform/"+env.Name, detail),
			SkipCheck("pluto/"+env.Name, detail),
		)
	}
	return out
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

	er := &envRender{
		env:         env,
		domain:      domain,
		generated:   map[string]string{},
		inherited:   map[string]inheritedValues{},
		parentFiles: map[string]string{},
	}
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

// valuesArgs builds the helm values arguments for a (chart, env) pair and a
// detail string describing where each value came from. The order mirrors the
// precedence ArgoCD applies: the chart's own files first, then the values the
// parent Application hands down through helm.valuesObject, then the
// parameters Terraform sets on the root Application.
func valuesArgs(opts RenderOptions, er *envRender, c Chart) ([]string, string) {
	var (
		args    []string
		sources []string
		missing string
	)
	if _, twoStage := TwoStageCharts[c.Name]; twoStage && er.env.TwoStage {
		base := filepath.ToSlash(filepath.Join(c.Path, "values.yaml"))
		gen := er.generated[c.Name]
		// The detail is part of the JSON contract and is snapshot-compared by
		// callers, so it carries the render-relative path. The absolute path
		// stays in the argv, where helm needs it.
		args = append(args, "-f", base, "-f", gen)
		sources = append(sources, base, shortPath(opts.OutDir, gen)+" (generated by config export)")
	} else {
		files := ValuesFiles(opts.RepoRoot, c, er.env.Name)
		for _, f := range files {
			args = append(args, "-f", f)
		}
		sources = append(sources, files...)
		envValues := "values-" + er.env.Name + ".yaml"
		if !containsSuffix(files, "/"+envValues) {
			missing = "; " + envValues + " missing"
		}
	}

	if inh, ok := er.inherited[c.Name]; ok {
		args = append(args, "-f", inh.path)
		sources = append(sources, shortPath(opts.OutDir, inh.path)+" (inherited from parent Application helm.valuesObject)")
	}
	detail := "values: " + strings.Join(sources, ", ") + missing

	// The root Application that Terraform creates for the gitops chart passes
	// global.domain as a helm parameter; nothing in git carries the real
	// domain. Level 0 injects the example env's domain the same way.
	if c.Name == "gitops" && er.env.TwoStage {
		args = append(args, "--set", "global.domain="+er.domain)
		detail += "; --set global.domain=" + er.domain + " (mirrors the Terraform root Application helm.parameters)"
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
func renderChart(ctx context.Context, opts RenderOptions, er *envRender, c Chart) ([]Check, string) {
	dest := RenderedFile(opts.OutDir, er.env.Name, c.Name)
	check, vargs := templateChart(ctx, opts, er, c, dest)
	if check.Status != StatusPass {
		return []Check{check}, ""
	}
	checks := []Check{check}
	if !opts.SkipLint {
		checks = append(checks, lintChart(ctx, opts, er, c, vargs))
	}
	return checks, dest
}

// renderParentForInheritance renders a parent the --chart filter left out,
// solely so the helm.valuesObject of its Applications can reach the selected
// children. The output lands under _parents/ and yields no check and no
// RenderOutput.Files entry; a failure surfaces through render/<env>/_inherit
// because the children would otherwise silently render without their values.
func renderParentForInheritance(ctx context.Context, opts RenderOptions, er *envRender, c Chart) (string, []string) {
	dest := filepath.Join(opts.OutDir, er.env.Name, "_parents", c.Name+".yaml")
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", []string{fmt.Sprintf("%s: creating %s: %v", c.Name, filepath.Dir(dest), err)}
	}
	check, _ := templateChart(ctx, opts, er, c, dest)
	if check.Status != StatusPass {
		findings := []string{fmt.Sprintf("%s: inherit-only render failed: %s", c.Name, check.Detail)}
		return "", append(findings, check.Findings...)
	}
	return dest, nil
}

// templateChart runs helm template for one (env, chart) pair and writes the
// output to dest. The check is named render/<env>/<chart>; the values
// arguments come back so helm lint can reuse them.
func templateChart(ctx context.Context, opts RenderOptions, er *envRender, c Chart, dest string) (Check, []string) {
	name := fmt.Sprintf("render/%s/%s", er.env.Name, c.Name)
	start := time.Now()

	vargs, detail := valuesArgs(opts, er, c)
	args := append([]string{"template", c.Name, c.Path, "--include-crds"}, vargs...)

	stdout, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "helm", args...)
	if err != nil {
		if isShimMissing(stderr) {
			return FailCheck(name, start, ToolMissingDetail("helm"), outputLines(stderr)...), vargs
		}
		return FailCheck(name, start,
			fmt.Sprintf("helm template failed (%v)", err),
			outputLines(stderr, stdout)...), vargs
	}

	if err := os.WriteFile(dest, stdout, 0o644); err != nil {
		return FailCheck(name, start, fmt.Sprintf("writing %s: %v", dest, err)), vargs
	}
	return PassCheck(name, start, detail), vargs
}

// lintChart runs helm lint. Only [ERROR] lines (or a non-zero exit) fail the
// check; [WARNING] and [INFO] lines are informational.
func lintChart(ctx context.Context, opts RenderOptions, er *envRender, c Chart, vargs []string) Check {
	name := fmt.Sprintf("lint/%s/%s", er.env.Name, c.Name)
	start := time.Now()

	args := append([]string{"lint", c.Path}, vargs...)
	stdout, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "helm", args...)

	if err != nil && isShimMissing(stderr) {
		return FailCheck(name, start, ToolMissingDetail("helm"), outputLines(stderr)...)
	}

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
func kubeconformCheck(ctx context.Context, opts RenderOptions, env Env, k8sVersion string, files map[string]string, sem chan struct{}) Check {
	name := "kubeconform/" + env.Name
	start := time.Now()

	if _, err := opts.Runner.LookPath("kubeconform"); err != nil {
		return FailCheck(name, start, ToolMissingDetail("kubeconform"))
	}
	paths := sortedValues(files)
	if len(paths) == 0 {
		return SkipCheck(name, "no rendered files for "+env.Name)
	}
	// Each env gets its own cache subdirectory. The two envs validate
	// concurrently, and kubeconform writes downloaded schemas into the cache
	// without locking, so a shared cold cache is a write race.
	cacheDir := filepath.Join(opts.CacheDir, env.Name)
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return FailCheck(name, start, fmt.Sprintf("creating kubeconform cache %s: %v", cacheDir, err))
	}

	args := []string{
		"-strict",
		"-summary",
		"-output", "json",
		"-kubernetes-version", k8sVersion,
		"-cache", cacheDir,
		"-schema-location", "default",
		"-schema-location", filepath.Join(opts.SchemaDir, "{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"),
	}
	args = append(args, paths...)

	sem <- struct{}{}
	stdout, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "kubeconform", args...)
	<-sem

	if err != nil && isShimMissing(stderr) {
		return FailCheck(name, start, ToolMissingDetail("kubeconform"), outputLines(stderr)...)
	}

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

// plutoCheck scans the rendered chart manifests for deprecated or removed APIs
// against the repo's target Kubernetes version.
//
// It runs `pluto detect <file>` once per rendered chart rather than
// `detect-files -d <dir>`, because the directory form would also walk
// _data.yaml and _values/, which are conftest input and Helm values, not
// Kubernetes manifests. pluto's detect-files flag takes a directory only, so an
// explicit file list means one invocation per file.
func plutoCheck(ctx context.Context, opts RenderOptions, env Env, k8sVersion string, files map[string]string, sem chan struct{}) Check {
	name := "pluto/" + env.Name
	start := time.Now()

	if _, err := opts.Runner.LookPath("pluto"); err != nil {
		return FailCheck(name, start, ToolMissingDetail("pluto"))
	}
	paths := sortedValues(files)
	if len(paths) == 0 {
		return SkipCheck(name, "no rendered files for "+env.Name)
	}

	var (
		mu           sync.Mutex
		findings     []string
		shimMiss     bool
		hardDetail   string
		hardFindings []string
		wg           sync.WaitGroup
	)

	for _, path := range paths {
		wg.Add(1)
		go func(path string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if ctx.Err() != nil {
				return
			}

			rel := shortPath(opts.OutDir, path)
			args := []string{
				"detect", path,
				"--target-versions", "k8s=v" + k8sVersion,
				"-o", "json",
			}
			stdout, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "pluto", args...)

			mu.Lock()
			defer mu.Unlock()

			// A version-manager shim resolves even when pluto is not
			// installed, so LookPath succeeds and the miss only surfaces as a
			// failed run. Report the missing tool, not the exit status.
			if err != nil && isShimMissing(stderr) {
				shimMiss = true
				if len(hardFindings) == 0 {
					hardFindings = outputLines(stderr)
				}
				return
			}

			var parsed plutoOutput
			if jerr := json.Unmarshal(stdout, &parsed); jerr != nil {
				if hardDetail == "" {
					if err != nil {
						hardDetail = fmt.Sprintf("pluto failed on %s (%v)", rel, err)
					} else {
						hardDetail = fmt.Sprintf("parsing pluto output for %s: %v", rel, jerr)
					}
					hardFindings = outputLines(stderr, stdout)
				}
				return
			}

			for _, it := range parsed.Items {
				if !it.Deprecated && !it.Removed {
					continue
				}
				state := "deprecated in " + orNA(it.API.DeprecatedIn)
				if it.Removed {
					state = "removed in " + orNA(it.API.RemovedIn)
				}
				// `pluto detect` reports on one file, so attribute the finding
				// to the path we passed rather than its (often empty) filePath.
				findings = append(findings, fmt.Sprintf("%s: %s %s/%s: %s; use %s",
					rel, it.API.Version, it.API.Kind, it.Name, state, orNA(it.API.ReplacementAPI)))
			}
		}(path)
	}
	wg.Wait()

	if shimMiss {
		return FailCheck(name, start, ToolMissingDetail("pluto"), hardFindings...)
	}
	sort.Strings(findings)
	if len(findings) > 0 {
		return FailCheck(name, start,
			fmt.Sprintf("%d deprecated or removed API(s) for k8s v%s across %d file(s)",
				len(findings), k8sVersion, len(paths)), findings...)
	}
	if hardDetail != "" {
		return FailCheck(name, start, hardDetail, hardFindings...)
	}
	return PassCheck(name, start,
		fmt.Sprintf("%d file(s) free of deprecated APIs for k8s v%s", len(paths), k8sVersion))
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
