package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// DefaultUpgradeMaxDiffLines caps the diff lines one upgrade check carries in
// its findings and in the markdown report.
const DefaultUpgradeMaxDiffLines = 400

// UpgradeUnchanged is the prefix of the detail of every upgrade check whose
// rendered manifests are identical at the base ref and the working tree. The
// automerge gate in .github/workflows/upgrade.yml keys on it.
const UpgradeUnchanged = "unchanged"

// upgradeDroppedLabels are stamped by most charts with the chart and app
// version. A bump rewrites them on every object, which would bury the change
// that matters, so they are removed before diffing.
var upgradeDroppedLabels = []string{"helm.sh/chart", "app.kubernetes.io/version"}

// upgradeRepoKey names the per-env check that diffs the level-0 render of the
// charts in this repository (as opposed to the upstream charts).
const upgradeRepoKey = "_repo"

// UpgradeOptions configures `homelab verify upgrade`: render every chart at a
// base git ref and at the working tree, then render and diff every upstream
// Helm chart an Application references whose source changed between the two.
type UpgradeOptions struct {
	// Runner executes git and helm; tests supply a fake.
	Runner Runner
	// RepoRoot is the working tree (the "head" side).
	RepoRoot string
	// BaseRef is any git revision (origin/main, a SHA, a tag).
	BaseRef string
	// Envs defaults to the homelab environment only: it is what production
	// renders, and the upstream charts it references are a superset of
	// localdev's.
	Envs []Env
	// WorkDir is required. It receives the base worktree (<WorkDir>/base),
	// both level-0 renders (<WorkDir>/render/{base,head}) and every upstream
	// render (<WorkDir>/upstream/{base,head}/<env>/<key>/).
	WorkDir string
	// Keep leaves the base worktree registered and on disk for inspection.
	Keep bool
	// MaxDiffLines caps the diff lines per check (default 400).
	MaxDiffLines int
	// Parallel bounds concurrent helm invocations (default: runtime.NumCPU()).
	Parallel int
	// Render defaults to Render; tests replace it to avoid a real config tree.
	Render func(context.Context, RenderOptions) (*RenderOutput, *Result)
}

func (o *UpgradeOptions) applyDefaults() {
	if o.Runner == nil {
		o.Runner = ExecRunner{}
	}
	if len(o.Envs) == 0 {
		if e, ok := EnvByName("homelab"); ok {
			o.Envs = []Env{e}
		}
	}
	if o.MaxDiffLines <= 0 {
		o.MaxDiffLines = DefaultUpgradeMaxDiffLines
	}
	if o.Parallel <= 0 {
		o.Parallel = runtime.NumCPU()
	}
	if o.Render == nil {
		o.Render = Render
	}
}

// HelmParameter is one spec.source.helm.parameters entry.
type HelmParameter struct {
	Name        string `json:"name"`
	Value       string `json:"value"`
	ForceString bool   `json:"forceString,omitempty"`
}

// ChartSource is one Helm chart source of an ArgoCD Application: spec.source
// or an entry of spec.sources that sets `chart`.
type ChartSource struct {
	// App is the Application name; Parent is the repo chart that renders it.
	App    string `json:"-"`
	Parent string `json:"-"`

	RepoURL        string          `json:"repoURL"`
	Chart          string          `json:"chart"`
	TargetRevision string          `json:"targetRevision"`
	ReleaseName    string          `json:"releaseName,omitempty"`
	Namespace      string          `json:"namespace,omitempty"`
	Values         string          `json:"values,omitempty"`
	ValuesObject   any             `json:"valuesObject,omitempty"`
	Parameters     []HelmParameter `json:"parameters,omitempty"`
	ValueFiles     []string        `json:"valueFiles,omitempty"`
	SkipCrds       bool            `json:"skipCrds,omitempty"`
}

// fingerprint is the identity used to decide whether a source changed.
func (s ChartSource) fingerprint() string {
	b, _ := json.Marshal(s)
	return string(b)
}

// release is the Helm release name ArgoCD uses: helm.releaseName, else the
// Application name.
func (s ChartSource) release() string {
	if s.ReleaseName != "" {
		return s.ReleaseName
	}
	return s.App
}

// UpgradeItem is one upgrade check's data, kept for the markdown report.
type UpgradeItem struct {
	// Check is the check name: upgrade/<env>/<key>.
	Check string
	Env   string
	// Key is the Application name, <app>/<chart> for an Application with
	// several chart sources, or "_repo" for the repository's own charts.
	Key        string
	Base, Head *ChartSource
	// Change summarises how the source differs (version a -> b, values, ...).
	Change string
	// Rendered is true when the upstream chart was rendered and diffed.
	Rendered       bool
	Added, Deleted int
	// CRDs lists CustomResourceDefinitions whose spec changed.
	CRDs      []string
	Diff      []string
	Truncated bool
}

// UpgradeOutput is everything the report needs besides the Result.
type UpgradeOutput struct {
	BaseRef string
	BaseSHA string
	WorkDir string
	Envs    []Env
	Items   []UpgradeItem
}

// ResolveRef returns the commit SHA a git revision names, or an error naming
// the revision when it does not exist.
func ResolveRef(ctx context.Context, r Runner, repoRoot, ref string) (string, error) {
	if strings.TrimSpace(ref) == "" {
		return "", fmt.Errorf("a base ref is required")
	}
	if strings.HasPrefix(ref, "-") {
		return "", fmt.Errorf("invalid base ref %q", ref)
	}
	stdout, stderr, err := r.Run(ctx, repoRoot, "git", "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		msg := strings.TrimSpace(string(stderr))
		if msg == "" {
			msg = "unknown revision"
		}
		return "", fmt.Errorf("base ref %q does not resolve to a commit (%s); fetch it first, e.g. git fetch origin main", ref, msg)
	}
	sha := strings.TrimSpace(string(stdout))
	if sha == "" {
		return "", fmt.Errorf("base ref %q resolved to an empty SHA", ref)
	}
	return sha, nil
}

// Upgrade renders the base ref and the working tree, collects every
// Application Helm chart source in both, and for each source that was added,
// removed or changed renders the upstream chart on both sides and diffs the
// normalised manifests. Like Render it never returns a Go error: every
// failure is a Check.
//
// Checks:
//
//	upgrade/base             the base ref resolved and its worktree was created
//	upgrade/<env>/_render    (fail only) the working tree failed to render
//	upgrade/<env>/_base-render (skip only) the base ref failed to render
//	upgrade/<env>/_repo      level-0 render of this repo's charts, base vs head,
//	                         with Application chart sources masked (they are the
//	                         per-app checks' job)
//	upgrade/<env>/<app>      one per upstream chart source
func Upgrade(ctx context.Context, opts UpgradeOptions) (*UpgradeOutput, *Result) {
	start := time.Now()
	opts.applyDefaults()
	res := NewResult(0)
	out := &UpgradeOutput{BaseRef: opts.BaseRef, WorkDir: opts.WorkDir, Envs: opts.Envs}

	fail := func(detail string, findings ...string) (*UpgradeOutput, *Result) {
		res.Add(FailCheck("upgrade/base", start, detail, findings...))
		res.Finalize(start)
		return out, res
	}
	switch {
	case opts.RepoRoot == "":
		return fail("UpgradeOptions.RepoRoot is required")
	case opts.WorkDir == "":
		return fail("UpgradeOptions.WorkDir is required")
	}
	for _, tool := range []string{"git", "helm"} {
		if _, err := opts.Runner.LookPath(tool); err != nil {
			return fail(ToolMissingDetail(tool))
		}
	}
	opts.Runner = pinTools(ctx, opts.Runner, opts.RepoRoot, "helm")

	sha, err := ResolveRef(ctx, opts.Runner, opts.RepoRoot, opts.BaseRef)
	if err != nil {
		return fail(err.Error())
	}
	out.BaseSHA = sha

	baseRoot := filepath.Join(opts.WorkDir, "base")
	if _, stderr, err := opts.Runner.Run(ctx, opts.RepoRoot, "git", "worktree", "add", "--detach", baseRoot, sha); err != nil {
		return fail(fmt.Sprintf("git worktree add %s %s failed (%v)", baseRoot, shortSHA(sha), err), nonEmptyLines(stderr)...)
	}
	if !opts.Keep {
		defer removeWorktree(opts.Runner, opts.RepoRoot, baseRoot)
	}
	res.Add(PassCheck("upgrade/base", start, fmt.Sprintf("%s = %s, rendered from a temporary git worktree", opts.BaseRef, shortSHA(sha))))

	// Both level-0 renders run concurrently; each bounds its own helm calls.
	renderOpts := func(root, side string) RenderOptions {
		return RenderOptions{
			RepoRoot:         root,
			OutDir:           filepath.Join(opts.WorkDir, "render", side),
			Envs:             opts.Envs,
			Parallel:         opts.Parallel,
			SkipLint:         true,
			OmitSchemaChecks: true,
			Runner:           opts.Runner,
		}
	}
	var (
		wg                 sync.WaitGroup
		baseOut, headOut   *RenderOutput
		baseRes, headRes   *Result
		baseKube, headKube string
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		baseOut, baseRes = opts.Render(ctx, renderOpts(baseRoot, "base"))
		// Each side renders upstream charts for its own tools.kubernetes.
		baseKube, _ = KubernetesVersion(baseRoot)
	}()
	go func() {
		defer wg.Done()
		headOut, headRes = opts.Render(ctx, renderOpts(opts.RepoRoot, "head"))
		headKube, _ = KubernetesVersion(opts.RepoRoot)
	}()
	wg.Wait()

	var jobs []*upgradeJob
	for _, env := range opts.Envs {
		headFailed, headFindings := failedRenders(headRes, env.Name)
		baseFailed, baseFindings := failedRenders(baseRes, env.Name)
		if len(headFindings) > 0 {
			res.Add(FailCheck(fmt.Sprintf("upgrade/%s/_render", env.Name), start,
				fmt.Sprintf("the working tree does not render for %s; Applications in the failed charts are not compared", env.Name),
				capLines(headFindings)...))
		}
		if len(baseFindings) > 0 {
			res.Add(Check{
				Name:     fmt.Sprintf("upgrade/%s/_base-render", env.Name),
				Status:   StatusSkip,
				Detail:   fmt.Sprintf("%s does not render for %s with the working tree's renderer; Applications added in the failed charts are reported as skipped", opts.BaseRef, env.Name),
				Findings: capLines(baseFindings),
			})
		}

		baseFiles := filesFor(baseOut, env.Name)
		headFiles := filesFor(headOut, env.Name)

		repoItem, repoCheck := repoDiff(env.Name, baseFiles, headFiles, baseFailed, headFailed, opts.MaxDiffLines)
		res.Add(repoCheck)
		out.Items = append(out.Items, repoItem)

		baseSrc, baseErr := sourcesFromFiles(baseFiles)
		headSrc, headErr := sourcesFromFiles(headFiles)
		if headErr != nil {
			res.Add(FailCheck(fmt.Sprintf("upgrade/%s/_render", env.Name), start, "parsing the working-tree render: "+headErr.Error()))
			continue
		}
		if baseErr != nil {
			res.Add(SkipCheck(fmt.Sprintf("upgrade/%s/_base-render", env.Name), "parsing the base render: "+baseErr.Error()))
		}

		for _, key := range unionKeys(baseSrc, headSrc) {
			b, bok := baseSrc[key]
			h, hok := headSrc[key]
			j := &upgradeJob{item: UpgradeItem{Check: fmt.Sprintf("upgrade/%s/%s", env.Name, key), Env: env.Name, Key: key}}
			if bok {
				j.item.Base = &b
			}
			if hok {
				j.item.Head = &h
			}
			j.item.Change = describeChange(j.item.Base, j.item.Head)
			switch {
			case bok && hok && b.fingerprint() == h.fingerprint():
				j.done = &Check{Name: j.item.Check, Status: StatusPass,
					Detail: fmt.Sprintf("%s: %s %s, chart source identical at base and head (not re-rendered)", UpgradeUnchanged, h.Chart, h.TargetRevision)}
			case !bok && baseFailed[h.Parent]:
				j.done = &Check{Name: j.item.Check, Status: StatusSkip,
					Detail: fmt.Sprintf("added in %s, whose base render failed; nothing to compare against", h.Parent)}
			default:
				j.render = true
				j.baseDir = filepath.Join(opts.WorkDir, "upstream", "base", env.Name, safeName(key))
				j.headDir = filepath.Join(opts.WorkDir, "upstream", "head", env.Name, safeName(key))
			}
			jobs = append(jobs, j)
		}
	}

	// Upstream renders: bounded fan-out, network-bound (chart pulls).
	sem := make(chan struct{}, opts.Parallel)
	var jwg sync.WaitGroup
	for _, j := range jobs {
		if !j.render {
			continue
		}
		jwg.Add(1)
		go func(j *upgradeJob) {
			defer jwg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if j.item.Base != nil {
				j.baseOut, j.baseErr = renderUpstream(ctx, opts.Runner, opts.WorkDir, *j.item.Base, baseKube, j.baseDir)
			}
			if j.item.Head != nil {
				j.headOut, j.headErr = renderUpstream(ctx, opts.Runner, opts.WorkDir, *j.item.Head, headKube, j.headDir)
			}
		}(j)
	}
	jwg.Wait()

	for _, j := range jobs {
		if j.done != nil {
			res.Add(*j.done)
			out.Items = append(out.Items, j.item)
			continue
		}
		out.Items = append(out.Items, j.item)
		item := &out.Items[len(out.Items)-1]
		res.Add(finishJob(j, item, opts.MaxDiffLines))
	}

	sort.SliceStable(out.Items, func(i, k int) bool { return out.Items[i].Check < out.Items[k].Check })
	res.Finalize(start)
	return out, res
}

// upgradeJob is one chart source comparison in flight.
type upgradeJob struct {
	item             UpgradeItem
	done             *Check
	render           bool
	baseDir, headDir string
	baseOut, headOut []byte
	baseErr, headErr *upstreamError
}

// upstreamError is a failed upstream render with helm's stderr.
type upstreamError struct {
	detail string
	lines  []string
}

// finishJob turns a rendered job into its check and fills the report item.
func finishJob(j *upgradeJob, item *UpgradeItem, maxLines int) Check {
	start := time.Now()
	name := item.Check
	switch {
	case j.headErr != nil:
		return FailCheck(name, start, fmt.Sprintf("helm template failed at head: %s (%s)", j.headErr.detail, item.Change), capLines(j.headErr.lines)...)
	case j.baseErr != nil:
		return Check{Name: name, Status: StatusSkip,
			Detail:   fmt.Sprintf("helm template failed at base, head renders: %s (%s)", j.baseErr.detail, item.Change),
			Findings: capLines(j.baseErr.lines)}
	}

	baseObjs, berr := normaliseManifest(j.baseOut)
	headObjs, herr := normaliseManifest(j.headOut)
	if herr != nil {
		return FailCheck(name, start, "parsing the head render: "+herr.Error())
	}
	if berr != nil {
		return Check{Name: name, Status: StatusSkip, Detail: "parsing the base render: " + berr.Error()}
	}

	item.Rendered = true
	lines, added, deleted := objectDiff(baseObjs, headObjs)
	item.Added, item.Deleted = added, deleted
	item.CRDs = changedCRDs(baseObjs, headObjs)
	item.Diff, item.Truncated = capDiff(lines, maxLines)

	if len(lines) == 0 {
		return PassCheck(name, start, fmt.Sprintf("%s: %s; rendered manifests identical after dropping %s labels",
			UpgradeUnchanged, item.Change, strings.Join(upgradeDroppedLabels, ", ")))
	}
	detail := fmt.Sprintf("manifest diff: +%d -%d lines (%s)", added, deleted, item.Change)
	if len(item.CRDs) > 0 {
		detail += "; CRDs changed: " + strings.Join(item.CRDs, ", ")
	}
	c := PassCheck(name, start, detail)
	c.Findings = item.Diff
	return c
}

// renderUpstream runs helm template for one chart source and returns its
// stdout. The values the Application passes inline are written to dir.
func renderUpstream(ctx context.Context, r Runner, workDir string, src ChartSource, kubeVersion, dir string) ([]byte, *upstreamError) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, &upstreamError{detail: err.Error()}
	}
	var files []string
	if strings.TrimSpace(src.Values) != "" {
		p := filepath.Join(dir, "values.yaml")
		if err := os.WriteFile(p, []byte(src.Values), 0o644); err != nil {
			return nil, &upstreamError{detail: err.Error()}
		}
		files = append(files, p)
	}
	if src.ValuesObject != nil {
		data, err := yaml.Marshal(src.ValuesObject)
		if err != nil {
			return nil, &upstreamError{detail: "marshalling helm.valuesObject: " + err.Error()}
		}
		p := filepath.Join(dir, "values-object.yaml")
		if err := os.WriteFile(p, data, 0o644); err != nil {
			return nil, &upstreamError{detail: err.Error()}
		}
		files = append(files, p)
	}

	args := upstreamArgs(src, kubeVersion, files)
	stdout, stderr, err := r.Run(ctx, workDir, "helm", args...)
	if err != nil {
		if isShimMissing(stderr) {
			return nil, &upstreamError{detail: ToolMissingDetail("helm")}
		}
		return nil, &upstreamError{detail: fmt.Sprintf("%s %s: %v", src.Chart, src.TargetRevision, err), lines: nonEmptyLines(stderr)}
	}
	_ = os.WriteFile(filepath.Join(dir, "manifest.yaml"), stdout, 0o644)
	return stdout, nil
}

// upstreamArgs builds `helm template` arguments mirroring what the ArgoCD repo
// server runs for a Helm source: release name, chart at the pinned version,
// destination namespace, CRDs unless skipCrds, the target Kubernetes version,
// inline values (values then valuesObject) and parameters last.
func upstreamArgs(src ChartSource, kubeVersion string, valuesFiles []string) []string {
	ref, repo := chartRef(src.RepoURL, src.Chart)
	args := []string{"template", src.release(), ref}
	if repo != "" {
		args = append(args, "--repo", repo)
	}
	if src.TargetRevision != "" {
		args = append(args, "--version", src.TargetRevision)
	}
	if src.Namespace != "" {
		args = append(args, "--namespace", src.Namespace)
	}
	if !src.SkipCrds {
		args = append(args, "--include-crds")
	}
	if kubeVersion != "" {
		args = append(args, "--kube-version", kubeVersion)
	}
	for _, f := range valuesFiles {
		args = append(args, "-f", f)
	}
	for _, p := range src.Parameters {
		flag := "--set"
		if p.ForceString {
			flag = "--set-string"
		}
		args = append(args, flag, p.Name+"="+p.Value)
	}
	return args
}

// chartRef returns the chart argument and the --repo URL for a source.
// ArgoCD writes OCI repositories without a scheme (oci.trueforge.org/truecharts,
// ghcr.io/renovatebot/charts); helm needs oci://<repo>/<chart>. An http(s)
// repository is passed with --repo.
func chartRef(repoURL, chart string) (ref, repo string) {
	u := strings.TrimSuffix(strings.TrimSpace(repoURL), "/")
	switch {
	case strings.HasPrefix(u, "oci://"):
		return u + "/" + chart, ""
	case strings.Contains(u, "://"):
		return chart, repoURL
	default:
		return "oci://" + u + "/" + chart, ""
	}
}

// pinnedRunner runs selected tools by absolute path instead of by name.
type pinnedRunner struct {
	Runner
	paths map[string]string
}

// Run implements Runner.
func (p pinnedRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, []byte, error) {
	if abs, ok := p.paths[name]; ok {
		name = abs
	}
	return p.Runner.Run(ctx, dir, name, args...)
}

// versionManagerShims maps a shim directory marker to the manager whose
// `<manager> which <tool>` names the real binary.
var versionManagerShims = map[string]string{"/mise/shims/": "mise", "/.asdf/shims/": "asdf"}

// pinTools resolves each tool that is a version-manager shim to the binary it
// runs in repoRoot and returns a Runner that invokes that binary directly.
//
// A shim picks the binary from the config of the directory it runs in. The
// base worktree is a fresh checkout whose mise.toml mise has never trusted,
// so every helm call there fails ("error parsing config file"), and even a
// trusted one would select the base ref's pins. Running the working tree's
// helm on both sides also keeps the renderer constant, so the diff shows the
// charts, not a helm upgrade. Tools that are not shims (CI's setup-helm) are
// left alone.
func pinTools(ctx context.Context, r Runner, repoRoot string, tools ...string) Runner {
	paths := map[string]string{}
	for _, tool := range tools {
		path, err := r.LookPath(tool)
		if err != nil {
			continue
		}
		slashed := filepath.ToSlash(path)
		for marker, manager := range versionManagerShims {
			if !strings.Contains(slashed, marker) {
				continue
			}
			out, _, err := r.Run(ctx, repoRoot, manager, "which", tool)
			if real := strings.TrimSpace(string(out)); err == nil && filepath.IsAbs(real) {
				paths[tool] = real
			}
		}
	}
	if len(paths) == 0 {
		return r
	}
	return pinnedRunner{Runner: r, paths: paths}
}

// removeWorktree unregisters and deletes the base worktree. It runs on a
// fresh context so a cancelled run still cleans up.
func removeWorktree(r Runner, repoRoot, dir string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, _, err := r.Run(ctx, repoRoot, "git", "worktree", "remove", "--force", dir); err != nil {
		_ = os.RemoveAll(dir)
		_, _, _ = r.Run(ctx, repoRoot, "git", "worktree", "prune")
	}
}

// failedRenders returns the charts whose level-0 render failed for env (plus
// every chart when a global render check failed) and one finding per failure.
// render/<env>/_committed-values is ignored: it compares committed files, not
// rendered manifests, and level 0 already reports it.
func failedRenders(res *Result, env string) (map[string]bool, []string) {
	failed := map[string]bool{}
	var findings []string
	if res == nil {
		return failed, []string{"render produced no result"}
	}
	for _, c := range res.Checks {
		if c.Status != StatusFail || !strings.HasPrefix(c.Name, "render/") {
			continue
		}
		parts := strings.Split(c.Name, "/")
		switch {
		case len(parts) == 2:
			failed["*"] = true
		case len(parts) == 3 && parts[1] == env && parts[2] != "_committed-values":
			failed[parts[2]] = true
		default:
			continue
		}
		f := c.Name + ": " + c.Detail
		if len(c.Findings) > 0 {
			f += " — " + c.Findings[0]
		}
		findings = append(findings, f)
	}
	return failed, findings
}

func filesFor(out *RenderOutput, env string) map[string]string {
	if out == nil || out.Files == nil {
		return map[string]string{}
	}
	if m, ok := out.Files[env]; ok {
		return m
	}
	return map[string]string{}
}

// sourcesFromFiles parses every rendered chart file and returns the chart
// sources of every Application, keyed as described on UpgradeItem.Key.
func sourcesFromFiles(files map[string]string) (map[string]ChartSource, error) {
	var docs []Doc
	for _, chart := range sortedKeys(files) {
		data, err := os.ReadFile(files[chart])
		if err != nil {
			return nil, err
		}
		d, err := ParseMultiDoc(chart, "", data)
		if err != nil {
			return nil, err
		}
		docs = append(docs, d...)
	}
	return chartSources(docs), nil
}

// chartSources extracts every Helm chart source from the Applications in
// docs. A git source (path) is not an upstream chart and is ignored; so is a
// `ref:`-only source of a multi-source Application.
func chartSources(docs []Doc) map[string]ChartSource {
	out := map[string]ChartSource{}
	for _, d := range docs {
		if d.Kind() != "Application" || !strings.HasPrefix(d.APIVersion(), "argoproj.io/") {
			continue
		}
		app := d.Name()
		dest := d.GetString("spec", "destination", "namespace")

		var raw []map[string]any
		if s, ok := d.Get("spec", "source"); ok {
			if m, ok := s.(map[string]any); ok {
				raw = append(raw, m)
			}
		}
		for _, s := range d.GetSlice("spec", "sources") {
			if m, ok := s.(map[string]any); ok {
				raw = append(raw, m)
			}
		}

		var srcs []ChartSource
		for _, m := range raw {
			chart, _ := m["chart"].(string)
			if chart == "" {
				continue
			}
			srcs = append(srcs, sourceFromMap(app, d.Chart, dest, m))
		}
		for i, s := range srcs {
			key := app
			if len(srcs) > 1 {
				key = app + "/" + s.Chart
				if n := countChart(srcs[:i], s.Chart); n > 0 {
					key = fmt.Sprintf("%s-%d", key, n+1)
				}
			}
			if _, dup := out[key]; dup {
				key = key + "@" + d.Chart
			}
			out[key] = s
		}
	}
	return out
}

func countChart(srcs []ChartSource, chart string) int {
	n := 0
	for _, s := range srcs {
		if s.Chart == chart {
			n++
		}
	}
	return n
}

func sourceFromMap(app, parent, dest string, m map[string]any) ChartSource {
	s := ChartSource{App: app, Parent: parent, Namespace: dest}
	s.RepoURL = stringOf(m["repoURL"])
	s.Chart = stringOf(m["chart"])
	s.TargetRevision = stringOf(m["targetRevision"])
	helm, _ := m["helm"].(map[string]any)
	if helm == nil {
		return s
	}
	s.ReleaseName = stringOf(helm["releaseName"])
	s.Values = stringOf(helm["values"])
	if vo, ok := helm["valuesObject"]; ok && vo != nil {
		s.ValuesObject = vo
	}
	if b, ok := helm["skipCrds"].(bool); ok {
		s.SkipCrds = b
	}
	for _, f := range asSlice(helm["valueFiles"]) {
		if str := stringOf(f); str != "" {
			s.ValueFiles = append(s.ValueFiles, str)
		}
	}
	for _, p := range asSlice(helm["parameters"]) {
		pm, ok := p.(map[string]any)
		if !ok {
			continue
		}
		hp := HelmParameter{Name: stringOf(pm["name"]), Value: stringOf(pm["value"])}
		if b, ok := pm["forceString"].(bool); ok {
			hp.ForceString = b
		}
		s.Parameters = append(s.Parameters, hp)
	}
	return s
}

func stringOf(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		return fmt.Sprintf("%v", t)
	}
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func unionKeys[V any](a, b map[string]V) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range []map[string]V{a, b} {
		for k := range m {
			if !seen[k] {
				seen[k] = true
				out = append(out, k)
			}
		}
	}
	sort.Strings(out)
	return out
}

// describeChange summarises how a chart source differs between base and head.
func describeChange(base, head *ChartSource) string {
	switch {
	case base == nil && head == nil:
		return ""
	case base == nil:
		return fmt.Sprintf("added: %s %s", head.Chart, head.TargetRevision)
	case head == nil:
		return fmt.Sprintf("removed: %s %s", base.Chart, base.TargetRevision)
	}
	var parts []string
	if base.RepoURL != head.RepoURL {
		parts = append(parts, fmt.Sprintf("repoURL %s → %s", base.RepoURL, head.RepoURL))
	}
	if base.Chart != head.Chart {
		parts = append(parts, fmt.Sprintf("chart %s → %s", base.Chart, head.Chart))
	}
	if base.TargetRevision != head.TargetRevision {
		parts = append(parts, fmt.Sprintf("%s %s → %s", head.Chart, base.TargetRevision, head.TargetRevision))
	}
	if base.release() != head.release() {
		parts = append(parts, fmt.Sprintf("releaseName %s → %s", base.release(), head.release()))
	}
	if base.Namespace != head.Namespace {
		parts = append(parts, fmt.Sprintf("namespace %s → %s", base.Namespace, head.Namespace))
	}
	bv := ChartSource{Values: base.Values, ValuesObject: base.ValuesObject, Parameters: base.Parameters, ValueFiles: base.ValueFiles, SkipCrds: base.SkipCrds}
	hv := ChartSource{Values: head.Values, ValuesObject: head.ValuesObject, Parameters: head.Parameters, ValueFiles: head.ValueFiles, SkipCrds: head.SkipCrds}
	if bv.fingerprint() != hv.fingerprint() {
		parts = append(parts, "values changed")
	}
	if len(parts) == 0 {
		return fmt.Sprintf("%s %s", head.Chart, head.TargetRevision)
	}
	return strings.Join(parts, ", ")
}

// repoDiff compares the level-0 render of this repository's own charts
// between base and head. Application chart sources are masked (targetRevision
// and helm are dropped) because the per-app checks own them; everything else
// — templates, smoke Jobs, git-path Applications, child charts — is diffed.
func repoDiff(env string, baseFiles, headFiles map[string]string, baseFailed, headFailed map[string]bool, maxLines int) (UpgradeItem, Check) {
	start := time.Now()
	item := UpgradeItem{Check: fmt.Sprintf("upgrade/%s/%s", env, upgradeRepoKey), Env: env, Key: upgradeRepoKey}
	baseObjs := map[string]string{}
	headObjs := map[string]string{}
	var skipped []string
	for _, chart := range unionKeys(baseFiles, headFiles) {
		if baseFailed[chart] || headFailed[chart] || baseFailed["*"] || headFailed["*"] {
			skipped = append(skipped, chart)
			continue
		}
		for side, files := range map[string]map[string]string{"base": baseFiles, "head": headFiles} {
			path, ok := files[chart]
			if !ok {
				continue
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return item, FailCheck(item.Check, start, fmt.Sprintf("reading the %s render of %s: %v", side, chart, err))
			}
			objs, err := normaliseRepoManifest(data)
			if err != nil {
				return item, FailCheck(item.Check, start, fmt.Sprintf("parsing the %s render of %s: %v", side, chart, err))
			}
			dst := baseObjs
			if side == "head" {
				dst = headObjs
			}
			for id, text := range objs {
				dst[chart+": "+id] = text
			}
		}
	}

	lines, added, deleted := objectDiff(baseObjs, headObjs)
	item.Rendered = true
	item.Added, item.Deleted = added, deleted
	item.Diff, item.Truncated = capDiff(lines, maxLines)
	item.Change = "charts in this repository (Application chart sources masked)"
	suffix := ""
	if len(skipped) > 0 {
		suffix = "; not compared (render failed): " + strings.Join(skipped, ", ")
	}
	if len(lines) == 0 {
		return item, PassCheck(item.Check, start, UpgradeUnchanged+": level-0 render of this repository's charts is identical apart from upstream chart sources"+suffix)
	}
	c := PassCheck(item.Check, start, fmt.Sprintf("manifest diff: +%d -%d lines in this repository's charts (Application chart sources masked; see upgrade/%s/<app>)%s", added, deleted, env, suffix))
	c.Findings = item.Diff
	return item, c
}

// normaliseManifest parses a helm render into "Kind/namespace/name" -> YAML
// text, with version labels dropped and keys sorted, so ordering, `# Source:`
// comments and chart-version stamps do not show up as changes.
func normaliseManifest(data []byte) (map[string]string, error) {
	return normaliseDocs(data, nil)
}

// normaliseRepoManifest is normaliseManifest plus masking of Application
// chart sources.
func normaliseRepoManifest(data []byte) (map[string]string, error) {
	return normaliseDocs(data, maskChartSources)
}

func normaliseDocs(data []byte, mutate func(map[string]any)) (map[string]string, error) {
	docs, err := ParseMultiDoc("", "", data)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, d := range docs {
		dropVersionLabels(d.Object)
		if mutate != nil {
			mutate(d.Object)
		}
		text, err := marshalYAML(d.Object)
		if err != nil {
			return nil, err
		}
		id := d.ID()
		for n := 2; ; n++ {
			if _, dup := out[id]; !dup {
				break
			}
			id = fmt.Sprintf("%s#%d", d.ID(), n)
		}
		out[id] = string(text)
	}
	return out, nil
}

// marshalYAML renders an object with sorted keys and the two-space indent
// kubectl and helm use, so diff lines read like the manifests they come from.
func marshalYAML(obj any) (string, error) {
	var b strings.Builder
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	if err := enc.Encode(obj); err != nil {
		return "", err
	}
	if err := enc.Close(); err != nil {
		return "", err
	}
	return b.String(), nil
}

// dropVersionLabels removes upgradeDroppedLabels from every `labels` map in
// the object (metadata, pod templates, volumeClaimTemplates). Selectors
// (matchLabels) are left alone: a version in a selector is a real change.
func dropVersionLabels(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			if k == "labels" {
				if m, ok := child.(map[string]any); ok {
					for _, l := range upgradeDroppedLabels {
						delete(m, l)
					}
				}
			}
			dropVersionLabels(child)
		}
	case []any:
		for _, child := range t {
			dropVersionLabels(child)
		}
	}
}

// maskChartSources drops targetRevision and helm from every chart source of an
// Application.
func maskChartSources(obj map[string]any) {
	if obj["kind"] != "Application" {
		return
	}
	spec, _ := obj["spec"].(map[string]any)
	if spec == nil {
		return
	}
	mask := func(v any) {
		m, ok := v.(map[string]any)
		if !ok {
			return
		}
		if c, _ := m["chart"].(string); c != "" {
			delete(m, "targetRevision")
			delete(m, "helm")
		}
	}
	mask(spec["source"])
	for _, s := range asSlice(spec["sources"]) {
		mask(s)
	}
}

// changedCRDs lists CRDs whose spec differs, plus added and removed ones.
func changedCRDs(base, head map[string]string) []string {
	crds := func(objs map[string]string) map[string]string {
		out := map[string]string{}
		for id, text := range objs {
			if !strings.HasPrefix(id, "CustomResourceDefinition/") {
				continue
			}
			var obj map[string]any
			if err := yaml.Unmarshal([]byte(text), &obj); err != nil {
				continue
			}
			spec, _ := json.Marshal(obj["spec"])
			name := strings.TrimPrefix(id, "CustomResourceDefinition/")
			name = strings.TrimPrefix(name, "/")
			out[name] = string(spec)
		}
		return out
	}
	b, h := crds(base), crds(head)
	var out []string
	for _, name := range unionKeys(b, h) {
		bs, bok := b[name]
		hs, hok := h[name]
		switch {
		case !bok:
			out = append(out, name+" (added)")
		case !hok:
			out = append(out, name+" (removed)")
		case bs != hs:
			out = append(out, name)
		}
	}
	return out
}

// objectDiff diffs two normalised object maps object by object and returns
// unified diff lines plus added/deleted line counts.
func objectDiff(base, head map[string]string) ([]string, int, int) {
	var (
		lines          []string
		added, deleted int
	)
	for _, id := range unionKeys(base, head) {
		b, h := base[id], head[id]
		if b == h {
			continue
		}
		hunks, a, d := unifiedHunks(lineDiff(splitLines([]byte(b)), splitLines([]byte(h))), 3)
		added += a
		deleted += d
		from, to := "base "+id, "head "+id
		if b == "" {
			from = "base (absent)"
		}
		if h == "" {
			to = "head (absent)"
		}
		lines = append(lines, "--- "+from, "+++ "+to)
		lines = append(lines, hunks...)
	}
	return lines, added, deleted
}

// capDiff truncates diff lines to max, appending a marker line.
func capDiff(lines []string, max int) ([]string, bool) {
	if max <= 0 || len(lines) <= max {
		return lines, false
	}
	out := append([]string(nil), lines[:max]...)
	out = append(out, fmt.Sprintf("... truncated: %d more diff line(s); rerun with --max-diff-lines or --keep to inspect the renders", len(lines)-max))
	return out, true
}

// lineOp is one line of an edit script: ' ' keep, '-' delete, '+' insert.
type lineOp struct {
	kind byte
	text string
}

// maxEditDistance bounds the Myers search. Beyond it the changed region is
// reported as a block replace, which is still a correct (if coarse) diff and
// keeps memory at O(maxEditDistance²).
const maxEditDistance = 2000

// lineDiff returns a minimal edit script from a to b (Myers' O(ND)
// algorithm after trimming the common prefix and suffix). Unlike the snapshot
// diff it scales to multi-thousand-line CRDs with a handful of changes.
func lineDiff(a, b []string) []lineOp {
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	suf := 0
	for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
		suf++
	}
	ops := make([]lineOp, 0, len(a)+len(b)-pre-suf)
	for _, l := range a[:pre] {
		ops = append(ops, lineOp{' ', l})
	}
	ops = append(ops, myers(a[pre:len(a)-suf], b[pre:len(b)-suf])...)
	for _, l := range a[len(a)-suf:] {
		ops = append(ops, lineOp{' ', l})
	}
	return ops
}

func myers(a, b []string) []lineOp {
	n, m := len(a), len(b)
	if n == 0 || m == 0 {
		return blockReplace(a, b)
	}
	maxD := n + m
	limit := maxD
	if limit > maxEditDistance {
		limit = maxEditDistance
	}
	off := maxD + 1
	v := make([]int, 2*maxD+3)
	// trace[d] holds v[off-d-1 .. off+d+1] as it was when iteration d began.
	var trace [][]int
	for d := 0; d <= limit; d++ {
		snap := make([]int, 2*d+3)
		copy(snap, v[off-d-1:off+d+2])
		trace = append(trace, snap)
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = v[off+k+1]
			} else {
				x = v[off+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x++
				y++
			}
			v[off+k] = x
			if x >= n && y >= m {
				return myersBacktrack(a, b, trace)
			}
		}
	}
	return blockReplace(a, b)
}

func myersBacktrack(a, b []string, trace [][]int) []lineOp {
	var rev []lineOp
	x, y := len(a), len(b)
	for d := len(trace) - 1; d >= 0; d-- {
		snap := trace[d]
		get := func(k int) int { return snap[k+d+1] }
		k := x - y
		var prevK int
		if k == -d || (k != d && get(k-1) < get(k+1)) {
			prevK = k + 1
		} else {
			prevK = k - 1
		}
		prevX := get(prevK)
		prevY := prevX - prevK
		for x > prevX && y > prevY {
			rev = append(rev, lineOp{' ', a[x-1]})
			x--
			y--
		}
		if d > 0 {
			if x == prevX {
				rev = append(rev, lineOp{'+', b[prevY]})
			} else {
				rev = append(rev, lineOp{'-', a[prevX]})
			}
		}
		x, y = prevX, prevY
	}
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	return rev
}

func blockReplace(a, b []string) []lineOp {
	ops := make([]lineOp, 0, len(a)+len(b))
	for _, l := range a {
		ops = append(ops, lineOp{'-', l})
	}
	for _, l := range b {
		ops = append(ops, lineOp{'+', l})
	}
	return ops
}

// unifiedHunks formats an edit script as unified-diff hunks with the given
// context and returns the lines plus added/deleted counts.
func unifiedHunks(ops []lineOp, context int) ([]string, int, int) {
	var changes []int
	added, deleted := 0, 0
	for i, op := range ops {
		switch op.kind {
		case '+':
			added++
			changes = append(changes, i)
		case '-':
			deleted++
			changes = append(changes, i)
		}
	}
	if len(changes) == 0 {
		return nil, 0, 0
	}
	// aLine[i]/bLine[i] are the 0-based line numbers before ops[i].
	aLine := make([]int, len(ops)+1)
	bLine := make([]int, len(ops)+1)
	for i, op := range ops {
		aLine[i+1], bLine[i+1] = aLine[i], bLine[i]
		if op.kind != '+' {
			aLine[i+1]++
		}
		if op.kind != '-' {
			bLine[i+1]++
		}
	}

	var out []string
	for i := 0; i < len(changes); {
		first := changes[i]
		last := first
		j := i + 1
		for j < len(changes) && changes[j]-last <= 2*context+1 {
			last = changes[j]
			j++
		}
		from := first - context
		if from < 0 {
			from = 0
		}
		to := last + context + 1
		if to > len(ops) {
			to = len(ops)
		}
		aStart, bStart := aLine[from], bLine[from]
		aLen, bLen := aLine[to]-aStart, bLine[to]-bStart
		if aLen > 0 {
			aStart++
		}
		if bLen > 0 {
			bStart++
		}
		out = append(out, fmt.Sprintf("@@ -%d,%d +%d,%d @@", aStart, aLen, bStart, bLen))
		for _, op := range ops[from:to] {
			out = append(out, string(op.kind)+op.text)
		}
		i = j
	}
	return out, added, deleted
}

var unsafeNameChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func safeName(s string) string { return unsafeNameChars.ReplaceAllString(s, "_") }

func shortSHA(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

// UpgradeReport renders the markdown report: a summary, a table of every
// chart source whose render was compared (identical sources are counted, not
// listed), and one collapsed diff per changed item.
//
// maxBytes > 0 bounds the report (a GitHub comment holds 65536 characters):
// the per-item diffs are halved until it fits, then dropped with a note
// pointing at the JSON findings, and as a last resort the text is cut at a
// line boundary.
func UpgradeReport(out *UpgradeOutput, res *Result, maxBytes int) string {
	longest := 0
	for _, it := range out.Items {
		longest = max(longest, len(it.Diff))
	}
	for _, c := range res.Checks {
		longest = max(longest, len(c.Findings))
	}
	limit := -1 // first pass: every diff line
	for {
		s := renderUpgradeReport(out, res, limit)
		if maxBytes <= 0 || len(s) <= maxBytes {
			return s
		}
		switch {
		case limit == 0:
			end := max(maxBytes-200, 0)
			cut := strings.LastIndex(s[:end], "\n")
			if cut < 0 {
				cut = end
			}
			return s[:cut] + "\n\n_Report truncated to fit; the full result is in the JSON output._\n"
		case limit < 0:
			limit = longest / 2
		default:
			limit /= 2
		}
		if limit < 10 {
			limit = 0
		}
	}
}

// renderUpgradeReport renders the report with at most diffLimit diff lines
// per item: negative means unlimited, 0 omits the diffs.
func renderUpgradeReport(out *UpgradeOutput, res *Result, diffLimit int) string {
	var b strings.Builder
	status := map[string]Check{}
	for _, c := range res.Checks {
		status[c.Name] = c
	}

	envs := make([]string, 0, len(out.Envs))
	for _, e := range out.Envs {
		envs = append(envs, e.Name)
	}
	fmt.Fprintf(&b, "## Upstream chart upgrade diff\n\n")
	fmt.Fprintf(&b, "Base `%s` (`%s`) vs the working tree, environment `%s`. Every Application Helm chart source that differs is rendered with `helm template` at both sides and diffed after dropping the `%s` labels.\n\n",
		out.BaseRef, shortSHA(out.BaseSHA), strings.Join(envs, "`, `"), strings.Join(upgradeDroppedLabels, "`, `"))

	var changed, identical, rendered []UpgradeItem
	for _, it := range out.Items {
		c := status[it.Check]
		switch {
		case c.Status == StatusPass && strings.HasPrefix(c.Detail, UpgradeUnchanged) && !it.Rendered:
			identical = append(identical, it)
		default:
			rendered = append(rendered, it)
			if c.Status != StatusPass || !strings.HasPrefix(c.Detail, UpgradeUnchanged) {
				changed = append(changed, it)
			}
		}
	}

	pass, fail, skip := res.Counts()
	verdict := "PASS"
	if !res.Pass {
		verdict = "FAIL"
	}
	fmt.Fprintf(&b, "**Result:** %s — %d check(s): %d passed, %d failed, %d skipped. **Rendered manifest changes:** %d item(s); %d chart source(s) identical at both sides.\n\n",
		verdict, len(res.Checks), pass, fail, skip, len(changed), len(identical))

	// Checks that are not per-item (base resolution, whole-render failures)
	// have no table row, so they are listed up front.
	var problems []Check
	for _, c := range res.Checks {
		if c.Status == StatusPass {
			continue
		}
		if c.Name == "upgrade/base" || strings.HasSuffix(c.Name, "/_render") || strings.HasSuffix(c.Name, "/_base-render") {
			problems = append(problems, c)
		}
	}
	for _, c := range problems {
		fmt.Fprintf(&b, "- **%s** `%s`: %s\n", strings.ToUpper(string(c.Status)), c.Name, c.Detail)
		for _, f := range c.Findings {
			fmt.Fprintf(&b, "  - %s\n", mdInline(f))
		}
	}
	if len(problems) > 0 {
		b.WriteString("\n")
	}

	if len(rendered) > 0 {
		b.WriteString("| Check | Chart | Base | Head | Status | Result |\n|---|---|---|---|---|---|\n")
		for _, it := range rendered {
			c := status[it.Check]
			chart, from, to := "", "—", "—"
			if it.Key == upgradeRepoKey {
				chart = "(this repository)"
			}
			if it.Base != nil {
				chart, from = it.Base.Chart, it.Base.TargetRevision
			}
			if it.Head != nil {
				chart, to = it.Head.Chart, it.Head.TargetRevision
			}
			result := "unchanged"
			switch {
			case c.Status == StatusFail:
				result = "head render failed"
			case c.Status == StatusSkip:
				result = "base render failed"
			case !strings.HasPrefix(c.Detail, UpgradeUnchanged):
				result = fmt.Sprintf("+%d −%d", it.Added, it.Deleted)
				if len(it.CRDs) > 0 {
					result += fmt.Sprintf(", %d CRD(s)", len(it.CRDs))
				}
			}
			fmt.Fprintf(&b, "| `%s` | %s | %s | %s | %s | %s |\n", it.Check, mdCell(chart), mdCell(from), mdCell(to), c.Status, result)
		}
		b.WriteString("\n")
	}

	if len(identical) > 0 {
		names := make([]string, 0, len(identical))
		for _, it := range identical {
			names = append(names, it.Key)
		}
		fmt.Fprintf(&b, "<details><summary>%d chart source(s) identical at base and head (not re-rendered)</summary>\n\n%s\n\n</details>\n\n", len(identical), strings.Join(names, ", "))
	}

	for _, it := range changed {
		c := status[it.Check]
		fmt.Fprintf(&b, "<details><summary><code>%s</code> — %s</summary>\n\n", it.Check, htmlEscape(c.Detail))
		if len(it.CRDs) > 0 {
			fmt.Fprintf(&b, "CRDs whose spec changed: %s\n\n", strings.Join(it.CRDs, ", "))
		}
		lines := it.Diff
		if c.Status != StatusPass {
			lines = c.Findings
		}
		switch {
		case diffLimit == 0 && len(lines) > 0:
			fmt.Fprintf(&b, "_Diff omitted to fit the report (%d line(s)); it is in this check's `findings` in the JSON result._\n\n", len(lines))
			lines = nil
		case diffLimit > 0 && len(lines) > diffLimit:
			rest := len(lines) - diffLimit
			lines = append(append([]string(nil), lines[:diffLimit]...),
				fmt.Sprintf("... %d more line(s) in this check's findings in the JSON result", rest))
		}
		if len(lines) > 0 {
			fence := "```diff"
			if c.Status != StatusPass {
				fence = "```text"
			}
			fmt.Fprintf(&b, "%s\n%s\n```\n\n", fence, strings.ReplaceAll(strings.Join(lines, "\n"), "```", "``​`"))
		}
		b.WriteString("</details>\n\n")
	}
	return b.String()
}

func mdCell(s string) string {
	if s == "" {
		return "—"
	}
	return strings.ReplaceAll(s, "|", "\\|")
}

func mdInline(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}
