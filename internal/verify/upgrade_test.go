package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// fakeUpgradeRunner answers git and helm for the upgrade flow. helm template
// output is looked up by "<chartRef>@<version>". Upgrade renders the base and
// head side of every changed source concurrently, so recording is locked.
type fakeUpgradeRunner struct {
	mu   sync.Mutex
	cmds []clusterCmd

	sha       string
	badRef    bool
	addErr    bool
	manifests map[string]string
	helmFail  map[string]string
}

func (f *fakeUpgradeRunner) LookPath(name string) (string, error) { return "/fake/bin/" + name, nil }

func (f *fakeUpgradeRunner) Run(_ context.Context, dir, name string, args ...string) ([]byte, []byte, error) {
	f.mu.Lock()
	f.cmds = append(f.cmds, clusterCmd{Dir: dir, Name: name, Args: append([]string(nil), args...)})
	f.mu.Unlock()
	switch name {
	case "git":
		switch args[0] {
		case "rev-parse":
			if f.badRef {
				return nil, []byte("fatal: Needed a single revision\n"), fmt.Errorf("exit status 1")
			}
			return []byte(f.sha + "\n"), nil, nil
		case "worktree":
			switch args[1] {
			case "add":
				if f.addErr {
					return nil, []byte("fatal: already exists\n"), fmt.Errorf("exit status 128")
				}
				return nil, nil, os.MkdirAll(args[3], 0o755)
			case "remove":
				return nil, nil, os.RemoveAll(args[2])
			}
		}
		return nil, nil, nil
	case "helm":
		key := args[2] + "@" + flagValue(args, "--version")
		if msg, ok := f.helmFail[key]; ok {
			return nil, []byte(msg), fmt.Errorf("exit status 1")
		}
		if m, ok := f.manifests[key]; ok {
			return []byte(m), nil, nil
		}
		return nil, []byte("Error: chart not found: " + key), fmt.Errorf("exit status 1")
	}
	return nil, nil, fmt.Errorf("unexpected tool %s", name)
}

func (f *fakeUpgradeRunner) helmCalls() []clusterCmd {
	var out []clusterCmd
	for _, c := range f.cmds {
		if c.Name == "helm" {
			out = append(out, c)
		}
	}
	return out
}

// fakeRender writes one canned render per side: the base side is recognised
// by its RepoRoot ending in /base.
func fakeRender(base, head map[string]string, baseFail []string) func(context.Context, RenderOptions) (*RenderOutput, *Result) {
	return func(_ context.Context, o RenderOptions) (*RenderOutput, *Result) {
		files, fail := head, []string(nil)
		if filepath.Base(o.RepoRoot) == "base" {
			files, fail = base, baseFail
		}
		out := &RenderOutput{Dir: o.OutDir, Envs: o.Envs, Files: map[string]map[string]string{}}
		res := NewResult(0)
		for _, env := range o.Envs {
			out.Files[env.Name] = map[string]string{}
			for chart, body := range files {
				p := RenderedFile(o.OutDir, env.Name, chart)
				_ = os.MkdirAll(filepath.Dir(p), 0o755)
				_ = os.WriteFile(p, []byte(body), 0o644)
				out.Files[env.Name][chart] = p
				res.Add(Check{Name: fmt.Sprintf("render/%s/%s", env.Name, chart), Status: StatusPass})
			}
			for _, chart := range fail {
				res.Add(Check{Name: fmt.Sprintf("render/%s/%s", env.Name, chart), Status: StatusFail, Detail: "helm template failed (exit status 1)"})
			}
		}
		return out, res
	}
}

func app(name, repo, chart, version, values string) string {
	return fmt.Sprintf(`apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: %s
  namespace: argocd
spec:
  source:
    repoURL: %s
    chart: %s
    targetRevision: %s
    helm:
      releaseName: %s
      values: |
        %s
  destination:
    namespace: ns-%s
---
`, name, repo, chart, version, name, values, name)
}

const gitApp = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: sonarr-config
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/ryanmcafee/homelab.git
    path: charts/sonarr-config
    targetRevision: main
  destination:
    namespace: media
---
`

func deployment(name, image, version string) string {
	return fmt.Sprintf(`# Source: %s/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: %s
  labels:
    app.kubernetes.io/name: %s
    app.kubernetes.io/version: %q
    helm.sh/chart: %s-%s
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/version: %q
    spec:
      containers:
        - name: main
          image: %s
---
`, name, name, name, version, name, version, version, image)
}

func crd(name, field string) string {
	return fmt.Sprintf(`apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: %s
spec:
  group: example.io
  versions:
    - name: v1
      schema:
        openAPIV3Schema:
          properties:
            %s:
              type: string
---
`, name, field)
}

func TestUpgradeFlow(t *testing.T) {
	baseRender := map[string]string{
		"applications": app("sonarr", "oci.trueforge.org/truecharts", "sonarr", "25.6.3", "a: 1") +
			app("radarr", "oci.trueforge.org/truecharts", "radarr", "26.7.2", "a: 1") +
			app("prowlarr", "oci.trueforge.org/truecharts", "prowlarr", "21.7.3", "a: 1") +
			app("tautulli", "oci.trueforge.org/truecharts", "tautulli", "21.18.2", "a: 1") +
			app("lazylibrarian", "oci.trueforge.org/truecharts", "lazylibrarian", "21.18.2", "a: 1") +
			gitApp,
		"addons": app("cert-manager", "https://charts.jetstack.io", "cert-manager", "v1.20.3", "crds: true"),
	}
	headRender := map[string]string{
		"applications": app("sonarr", "oci.trueforge.org/truecharts", "sonarr", "25.6.3", "a: 1") + // identical
			app("radarr", "oci.trueforge.org/truecharts", "radarr", "26.7.3", "a: 1") + // bump, image changes
			app("prowlarr", "oci.trueforge.org/truecharts", "prowlarr", "21.7.4", "a: 1") + // bump, labels only
			app("tautulli", "oci.trueforge.org/truecharts", "tautulli", "21.18.3", "a: 1") + // head render fails
			app("nzbget", "oci.trueforge.org/truecharts", "nzbget", "29.4.2", "a: 1") + // added
			strings.Replace(gitApp, "main", "feature", 1), // git-path app changed: _repo
		"addons": app("cert-manager", "https://charts.jetstack.io", "cert-manager", "v1.21.0", "crds: true"),
		// lazylibrarian removed
	}
	r := &fakeUpgradeRunner{
		sha: "0123456789abcdef0123456789abcdef01234567",
		manifests: map[string]string{
			"oci://oci.trueforge.org/truecharts/radarr@26.7.2":         deployment("radarr", "radarr:5.1", "5.1"),
			"oci://oci.trueforge.org/truecharts/radarr@26.7.3":         deployment("radarr", "radarr:5.2", "5.2"),
			"oci://oci.trueforge.org/truecharts/prowlarr@21.7.3":       deployment("prowlarr", "prowlarr:1", "1.0"),
			"oci://oci.trueforge.org/truecharts/prowlarr@21.7.4":       deployment("prowlarr", "prowlarr:1", "1.1"),
			"oci://oci.trueforge.org/truecharts/tautulli@21.18.2":      deployment("tautulli", "t:1", "1"),
			"oci://oci.trueforge.org/truecharts/nzbget@29.4.2":         deployment("nzbget", "n:1", "1"),
			"oci://oci.trueforge.org/truecharts/lazylibrarian@21.18.2": deployment("lazylibrarian", "l:1", "1"),
			"cert-manager@v1.20.3":                                     crd("certificates.cert-manager.io", "old") + deployment("cert-manager", "cm:1.20", "1.20"),
			"cert-manager@v1.21.0":                                     crd("certificates.cert-manager.io", "new") + crd("issuers.cert-manager.io", "x") + deployment("cert-manager", "cm:1.21", "1.21"),
		},
		helmFail: map[string]string{
			"oci://oci.trueforge.org/truecharts/tautulli@21.18.3": "Error: failed to download tautulli",
		},
	}
	work := t.TempDir()
	out, res := Upgrade(context.Background(), UpgradeOptions{
		Runner: r, RepoRoot: t.TempDir(), BaseRef: "origin/main", WorkDir: work,
		Render: fakeRender(baseRender, headRender, nil),
	})

	got := map[string]Check{}
	for _, c := range res.Checks {
		got[c.Name] = c
	}
	want := []struct {
		name, status, detailPrefix string
	}{
		{"upgrade/base", "pass", "origin/main = 0123456789ab"},
		{"upgrade/homelab/sonarr", "pass", "unchanged: sonarr 25.6.3, chart source identical"},
		{"upgrade/homelab/radarr", "pass", "manifest diff: +1 -1 lines (radarr 26.7.2 → 26.7.3)"},
		{"upgrade/homelab/prowlarr", "pass", "unchanged: prowlarr 21.7.3 → 21.7.4; rendered manifests identical"},
		{"upgrade/homelab/tautulli", "fail", "helm template failed at head"},
		{"upgrade/homelab/nzbget", "pass", "manifest diff: +"},
		{"upgrade/homelab/lazylibrarian", "pass", "manifest diff: +0 -"},
		{"upgrade/homelab/cert-manager", "pass", "manifest diff: "},
		{"upgrade/homelab/_repo", "pass", "manifest diff: +"},
	}
	for _, w := range want {
		c, ok := got[w.name]
		if !ok {
			t.Errorf("missing check %s; have %v", w.name, checkNames(got))
			continue
		}
		if string(c.Status) != w.status || !strings.HasPrefix(c.Detail, w.detailPrefix) {
			t.Errorf("%s = %s %q, want %s with prefix %q", w.name, c.Status, c.Detail, w.status, w.detailPrefix)
		}
	}
	if len(got) != len(want) {
		t.Errorf("got %d checks, want %d: %v", len(got), len(want), checkNames(got))
	}
	if res.Pass {
		t.Error("result passes although the tautulli head render failed")
	}

	cm := got["upgrade/homelab/cert-manager"]
	if !strings.Contains(cm.Detail, "CRDs changed: certificates.cert-manager.io, issuers.cert-manager.io (added)") {
		t.Errorf("cert-manager detail lacks CRD list: %q", cm.Detail)
	}
	if !containsLine(got["upgrade/homelab/radarr"].Findings, "+        - image: radarr:5.2") {
		t.Errorf("radarr findings lack the image change: %v", got["upgrade/homelab/radarr"].Findings)
	}
	for _, f := range got["upgrade/homelab/prowlarr"].Findings {
		t.Errorf("prowlarr must carry no findings, got %q", f)
	}

	// Identical sources are never rendered; both sides of each changed one are.
	calls := map[string]int{}
	for _, c := range r.helmCalls() {
		calls[c.Args[2]]++
	}
	if calls["oci://oci.trueforge.org/truecharts/sonarr"] != 0 {
		t.Error("identical sonarr source was rendered")
	}
	if calls["oci://oci.trueforge.org/truecharts/radarr"] != 2 || calls["cert-manager"] != 2 || calls["oci://oci.trueforge.org/truecharts/nzbget"] != 1 {
		t.Errorf("unexpected helm calls: %v", calls)
	}

	// The worktree is created at the resolved SHA and removed afterwards.
	var add, remove bool
	for _, c := range r.cmds {
		line := c.line()
		if strings.HasPrefix(line, "git worktree add --detach "+filepath.Join(work, "base")+" "+r.sha) {
			add = true
		}
		if strings.HasPrefix(line, "git worktree remove --force "+filepath.Join(work, "base")) {
			remove = true
		}
	}
	if !add || !remove {
		t.Errorf("worktree add=%v remove=%v; commands: %v", add, remove, r.cmds)
	}
	if out.BaseSHA != r.sha {
		t.Errorf("BaseSHA = %q", out.BaseSHA)
	}
}

func TestUpgradeKeepLeavesWorktree(t *testing.T) {
	r := &fakeUpgradeRunner{sha: "abc"}
	work := t.TempDir()
	render := map[string]string{"applications": gitApp}
	_, res := Upgrade(context.Background(), UpgradeOptions{
		Runner: r, RepoRoot: t.TempDir(), BaseRef: "origin/main", WorkDir: work, Keep: true,
		Render: fakeRender(render, render, nil),
	})
	if !res.Pass {
		t.Fatalf("expected pass: %+v", res.Checks)
	}
	for _, c := range r.cmds {
		if strings.Contains(c.line(), "worktree remove") {
			t.Fatal("--keep must not remove the worktree")
		}
	}
	if _, err := os.Stat(filepath.Join(work, "base")); err != nil {
		t.Fatalf("base worktree missing: %v", err)
	}
}

func TestUpgradeBaseProblems(t *testing.T) {
	tests := []struct {
		name       string
		runner     *fakeUpgradeRunner
		baseFail   []string
		wantCheck  string
		wantStatus Status
		wantDetail string
	}{
		{"unknown ref fails upgrade/base", &fakeUpgradeRunner{badRef: true}, nil, "upgrade/base", StatusFail, "does not resolve to a commit"},
		{"worktree add failure fails upgrade/base", &fakeUpgradeRunner{sha: "abc", addErr: true}, nil, "upgrade/base", StatusFail, "git worktree add"},
		{"base render failure is a skip", &fakeUpgradeRunner{sha: "abc"}, []string{"applications"}, "upgrade/homelab/_base-render", StatusSkip, "does not render"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			render := map[string]string{"applications": gitApp}
			_, res := Upgrade(context.Background(), UpgradeOptions{
				Runner: tc.runner, RepoRoot: t.TempDir(), BaseRef: "origin/main", WorkDir: t.TempDir(),
				Render: fakeRender(render, render, tc.baseFail),
			})
			for _, c := range res.Checks {
				if c.Name == tc.wantCheck {
					if c.Status != tc.wantStatus || !strings.Contains(c.Detail, tc.wantDetail) {
						t.Errorf("%s = %s %q", c.Name, c.Status, c.Detail)
					}
					return
				}
			}
			t.Errorf("no check %s in %+v", tc.wantCheck, res.Checks)
		})
	}
}

func TestChartSources(t *testing.T) {
	multi := `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: multi
spec:
  sources:
    - repoURL: https://github.com/ryanmcafee/homelab.git
      targetRevision: main
      ref: values
    - repoURL: https://charts.example.com
      chart: alpha
      targetRevision: 1.0.0
      helm:
        valuesObject:
          replicas: 2
        parameters:
          - name: image.tag
            value: "1.2"
            forceString: true
        valueFiles:
          - $values/charts/x/values.yaml
    - repoURL: ghcr.io/example/charts
      chart: beta
      targetRevision: 2.0.0
      helm:
        skipCrds: true
  destination:
    namespace: multi-ns
`
	docs, err := ParseMultiDoc("addons", "homelab", []byte(multi+"---\n"+gitApp+app("single", "https://r.example.com/", "single", "3.0.0", "k: v")))
	if err != nil {
		t.Fatal(err)
	}
	got := chartSources(docs)

	want := map[string]ChartSource{
		"multi/alpha": {App: "multi", Parent: "addons", RepoURL: "https://charts.example.com", Chart: "alpha", TargetRevision: "1.0.0",
			Namespace: "multi-ns", ValuesObject: map[string]any{"replicas": 2},
			Parameters: []HelmParameter{{Name: "image.tag", Value: "1.2", ForceString: true}},
			ValueFiles: []string{"$values/charts/x/values.yaml"}},
		"multi/beta": {App: "multi", Parent: "addons", RepoURL: "ghcr.io/example/charts", Chart: "beta", TargetRevision: "2.0.0",
			Namespace: "multi-ns", SkipCrds: true},
		"single": {App: "single", Parent: "addons", RepoURL: "https://r.example.com/", Chart: "single", TargetRevision: "3.0.0",
			ReleaseName: "single", Namespace: "ns-single", Values: "k: v\n"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("chartSources:\n got %#v\nwant %#v", got, want)
	}
}

func TestUpstreamArgs(t *testing.T) {
	tests := []struct {
		name string
		src  ChartSource
		kube string
		vals []string
		want []string
	}{
		{
			name: "OCI repository without a scheme",
			src:  ChartSource{App: "sonarr", RepoURL: "oci.trueforge.org/truecharts", Chart: "sonarr", TargetRevision: "25.6.3", Namespace: "media"},
			kube: "1.37.0",
			vals: []string{"/w/values.yaml"},
			want: []string{"template", "sonarr", "oci://oci.trueforge.org/truecharts/sonarr", "--version", "25.6.3", "--namespace", "media", "--include-crds", "--kube-version", "1.37.0", "-f", "/w/values.yaml"},
		},
		{
			name: "OCI repository with a scheme and trailing slash",
			src:  ChartSource{App: "x", RepoURL: "oci://ghcr.io/org/charts/", Chart: "x", TargetRevision: "1.0.0"},
			want: []string{"template", "x", "oci://ghcr.io/org/charts/x", "--version", "1.0.0", "--include-crds"},
		},
		{
			name: "https repository uses --repo, release name, skipCrds and parameters",
			src: ChartSource{App: "external-dns-unifi", RepoURL: "https://kubernetes-sigs.github.io/external-dns/", Chart: "external-dns", TargetRevision: "1.21.1",
				ReleaseName: "external-dns-unifi", Namespace: "external-dns", SkipCrds: true,
				Parameters: []HelmParameter{{Name: "a", Value: "1"}, {Name: "b", Value: "2", ForceString: true}}},
			vals: []string{"/w/values.yaml", "/w/values-object.yaml"},
			want: []string{"template", "external-dns-unifi", "external-dns", "--repo", "https://kubernetes-sigs.github.io/external-dns/", "--version", "1.21.1", "--namespace", "external-dns",
				"-f", "/w/values.yaml", "-f", "/w/values-object.yaml", "--set", "a=1", "--set-string", "b=2"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := upstreamArgs(tc.src, tc.kube, tc.vals); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("upstreamArgs:\n got %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestNormaliseManifest(t *testing.T) {
	a := deployment("app", "img:1", "1.0") + "apiVersion: v1\nkind: Service\nmetadata:\n  name: app\n  labels:\n    helm.sh/chart: app-1\n    keep: \"yes\"\nspec:\n  selector:\n    app.kubernetes.io/version: \"1.0\"\n"
	b := "apiVersion: v1\nkind: Service\nmetadata:\n  name: app\n  labels:\n    keep: \"yes\"\n    helm.sh/chart: app-2\nspec:\n  selector:\n    app.kubernetes.io/version: \"1.0\"\n---\n" + deployment("app", "img:1", "2.0")

	na, err := normaliseManifest([]byte(a))
	if err != nil {
		t.Fatal(err)
	}
	nb, err := normaliseManifest([]byte(b))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(na, nb) {
		t.Errorf("reordered docs with different version labels must normalise equal:\n%v\n%v", na, nb)
	}
	if strings.Contains(na["Deployment//app"], "app.kubernetes.io/version") || strings.Contains(na["Deployment//app"], "helm.sh/chart") {
		t.Errorf("version labels survived: %s", na["Deployment//app"])
	}
	if !strings.Contains(na["Service//app"], "app.kubernetes.io/version") {
		t.Error("a selector is a real contract and must keep its labels")
	}
}

func TestMaskChartSourcesKeepsGitSources(t *testing.T) {
	base := app("sonarr", "oci.trueforge.org/truecharts", "sonarr", "1.0.0", "a: 1") + gitApp
	head := app("sonarr", "oci.trueforge.org/truecharts", "sonarr", "2.0.0", "a: 2") + gitApp
	nb, _ := normaliseRepoManifest([]byte(base))
	nh, _ := normaliseRepoManifest([]byte(head))
	if lines, _, _ := objectDiff(nb, nh); len(lines) != 0 {
		t.Errorf("chart source changes must be masked in the repo diff: %v", lines)
	}
	nh2, _ := normaliseRepoManifest([]byte(strings.Replace(head, "path: charts/sonarr-config", "path: charts/other", 1)))
	if lines, a, d := objectDiff(nb, nh2); a != 1 || d != 1 {
		t.Errorf("git source change must show: +%d -%d %v", a, d, lines)
	}
}

func TestLineDiffAndHunks(t *testing.T) {
	tests := []struct {
		name       string
		a, b       []string
		want       []string
		added, del int
	}{
		{"identical", []string{"x", "y"}, []string{"x", "y"}, nil, 0, 0},
		{"one change with context", []string{"1", "2", "3", "4", "5", "6", "7", "8"}, []string{"1", "2", "3", "4", "X", "6", "7", "8"},
			[]string{"@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+X", " 6", " 7", " 8"}, 1, 1},
		{"added object", nil, []string{"a", "b"}, []string{"@@ -0,0 +1,2 @@", "+a", "+b"}, 2, 0},
		{"removed object", []string{"a"}, nil, []string{"@@ -1,1 +0,0 @@", "-a"}, 0, 1},
		{"two distant changes make two hunks",
			[]string{"a", "1", "2", "3", "4", "5", "6", "7", "8", "9", "b"},
			[]string{"A", "1", "2", "3", "4", "5", "6", "7", "8", "9", "B"},
			[]string{"@@ -1,4 +1,4 @@", "-a", "+A", " 1", " 2", " 3", "@@ -8,4 +8,4 @@", " 7", " 8", " 9", "-b", "+B"}, 2, 2},
		{"insertion in the middle", []string{"a", "b", "c"}, []string{"a", "b", "n", "c"},
			[]string{"@@ -1,3 +1,4 @@", " a", " b", "+n", " c"}, 1, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, added, del := unifiedHunks(lineDiff(tc.a, tc.b), 3)
			if !reflect.DeepEqual(got, tc.want) || added != tc.added || del != tc.del {
				t.Errorf("got %q +%d -%d, want %q +%d -%d", got, added, del, tc.want, tc.added, tc.del)
			}
		})
	}
}

func TestLineDiffLargeInputIsMinimal(t *testing.T) {
	// A 6000-line CRD with a change near each end: the snapshot diff's LCS
	// guard would degrade to a full block replace; Myers stays minimal.
	a := make([]string, 6000)
	for i := range a {
		a[i] = fmt.Sprintf("line %d", i)
	}
	b := append([]string(nil), a...)
	b[1] = "changed top"
	b[5998] = "changed bottom"
	_, added, del := unifiedHunks(lineDiff(a, b), 3)
	if added != 2 || del != 2 {
		t.Errorf("got +%d -%d, want +2 -2", added, del)
	}
}

func TestLineDiffFallsBackBeyondEditLimit(t *testing.T) {
	a := make([]string, maxEditDistance+10)
	b := make([]string, maxEditDistance+10)
	for i := range a {
		a[i] = fmt.Sprintf("a%d", i)
		b[i] = fmt.Sprintf("b%d", i)
	}
	ops := lineDiff(a, b)
	if len(ops) != len(a)+len(b) {
		t.Fatalf("block replace expected, got %d ops", len(ops))
	}
}

func TestCapDiff(t *testing.T) {
	lines := []string{"1", "2", "3", "4", "5"}
	got, truncated := capDiff(lines, 3)
	if !truncated || len(got) != 4 || !strings.Contains(got[3], "2 more diff line(s)") {
		t.Errorf("capDiff = %v %v", got, truncated)
	}
	if got, truncated := capDiff(lines, 10); truncated || len(got) != 5 {
		t.Errorf("no truncation expected: %v", got)
	}
}

func TestUpgradeReport(t *testing.T) {
	res := NewResult(0)
	res.Add(
		Check{Name: "upgrade/base", Status: StatusPass, Detail: "origin/main = abc"},
		Check{Name: "upgrade/homelab/_repo", Status: StatusPass, Detail: "unchanged: level-0 render identical"},
		Check{Name: "upgrade/homelab/radarr", Status: StatusPass, Detail: "manifest diff: +1 -1 lines (radarr 1 → 2)", Findings: []string{"--- base Deployment//radarr", "-image: a", "+image: b"}},
		Check{Name: "upgrade/homelab/sonarr", Status: StatusPass, Detail: "unchanged: sonarr 1, chart source identical at base and head (not re-rendered)"},
		Check{Name: "upgrade/homelab/tautulli", Status: StatusFail, Detail: "helm template failed at head: x", Findings: []string{"Error: boom"}},
	)
	out := &UpgradeOutput{
		BaseRef: "origin/main", BaseSHA: "abcdef0123456789", Envs: []Env{{Name: "homelab"}},
		Items: []UpgradeItem{
			{Check: "upgrade/homelab/_repo", Env: "homelab", Key: "_repo", Rendered: true},
			{Check: "upgrade/homelab/radarr", Env: "homelab", Key: "radarr", Rendered: true, Added: 1, Deleted: 1,
				Base: &ChartSource{Chart: "radarr", TargetRevision: "1"}, Head: &ChartSource{Chart: "radarr", TargetRevision: "2"},
				Diff: []string{"--- base Deployment//radarr", "-image: a", "+image: b"}},
			{Check: "upgrade/homelab/sonarr", Env: "homelab", Key: "sonarr",
				Base: &ChartSource{Chart: "sonarr", TargetRevision: "1"}, Head: &ChartSource{Chart: "sonarr", TargetRevision: "1"}},
			{Check: "upgrade/homelab/tautulli", Env: "homelab", Key: "tautulli",
				Base: &ChartSource{Chart: "tautulli", TargetRevision: "1"}, Head: &ChartSource{Chart: "tautulli", TargetRevision: "2"}},
		},
	}
	md := UpgradeReport(out, res, 0)
	for _, want := range []string{
		"## Upstream chart upgrade diff",
		"Base `origin/main` (`abcdef012345`)",
		"**Result:** FAIL",
		"**Rendered manifest changes:** 2 item(s); 1 chart source(s) identical",
		"| `upgrade/homelab/radarr` | radarr | 1 | 2 | pass | +1 −1 |",
		"| `upgrade/homelab/tautulli` | tautulli | 1 | 2 | fail | head render failed |",
		"| `upgrade/homelab/_repo` | (this repository) | — | — | pass | unchanged |",
		"<details><summary>1 chart source(s) identical at base and head (not re-rendered)</summary>",
		"<details><summary><code>upgrade/homelab/radarr</code> — manifest diff: +1 -1 lines (radarr 1 → 2)</summary>",
		"```diff\n--- base Deployment//radarr\n-image: a\n+image: b\n```",
		"```text\nError: boom\n```",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("report lacks %q:\n%s", want, md)
		}
	}
	if strings.Contains(md, "| `upgrade/homelab/sonarr`") {
		t.Error("identical sources belong in the collapsed list, not the table")
	}
}

func TestResolveRefRejectsOptionLikeRefs(t *testing.T) {
	r := &fakeUpgradeRunner{sha: "abc"}
	for _, ref := range []string{"", "  ", "--output=/tmp/x"} {
		if _, err := ResolveRef(context.Background(), r, "/repo", ref); err == nil {
			t.Errorf("ResolveRef(%q) succeeded", ref)
		}
	}
	if len(r.cmds) != 0 {
		t.Errorf("git must not run for rejected refs: %v", r.cmds)
	}
}

func checkNames(m map[string]Check) []string { return sortedKeys(m) }

// shimRunner reports helm as a mise shim and records what was executed.
type shimRunner struct{ ran []string }

func (s *shimRunner) LookPath(name string) (string, error) {
	return "/home/u/.local/share/mise/shims/" + name, nil
}

func (s *shimRunner) Run(_ context.Context, _ string, name string, args ...string) ([]byte, []byte, error) {
	s.ran = append(s.ran, name+" "+strings.Join(args, " "))
	if name == "mise" && len(args) == 2 && args[0] == "which" {
		return []byte("/home/u/.local/share/mise/installs/" + args[1] + "/4.3.0/" + args[1] + "\n"), nil, nil
	}
	return nil, nil, nil
}

func TestPinToolsBypassesVersionManagerShims(t *testing.T) {
	s := &shimRunner{}
	r := pinTools(context.Background(), s, "/repo", "helm")
	_, _, _ = r.Run(context.Background(), "/work/base", "helm", "template", "x")
	_, _, _ = r.Run(context.Background(), "/work/base", "git", "status")
	want := []string{
		"mise which helm",
		"/home/u/.local/share/mise/installs/helm/4.3.0/helm template x",
		"git status",
	}
	if !reflect.DeepEqual(s.ran, want) {
		t.Errorf("ran %q, want %q", s.ran, want)
	}

	// A binary that is not a shim (CI's setup-helm) is used as-is.
	f := &fakeUpgradeRunner{}
	if got := pinTools(context.Background(), f, "/repo", "helm"); got != Runner(f) {
		t.Errorf("non-shim runner was wrapped: %#v", got)
	}
}

func containsLine(lines []string, want string) bool {
	for _, l := range lines {
		if l == want {
			return true
		}
	}
	return false
}
