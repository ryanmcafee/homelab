package verify

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/config"
)

// versionDriftFileName is the registry of accepted chart-version drift.
const versionDriftFileName = "version-drift.yaml"

// VersionDrift is one tests/gitops/version-drift.yaml entry: an Application
// whose chart source renders a targetRevision that is not the
// configuration/versions.yaml pin. Every field is mandatory, and an entry that
// no longer describes the render (the revision moved, or the drift is gone)
// fails the check, so exceptions cannot outlive their reason.
type VersionDrift struct {
	Application string `yaml:"application"`
	Chart       string `yaml:"chart"`
	Revision    string `yaml:"revision"`
	Reason      string `yaml:"reason"`
}

// PinLag is one `pins:` entry of the same file: a file outside the render path
// (see pinSources) that may carry `revision` for `key` (section.key of
// versions.yaml) instead of the pin, because an upgrade is in progress. As with
// VersionDrift, the entry fails once the file no longer carries `revision`.
type PinLag struct {
	File     string `yaml:"file"`
	Key      string `yaml:"key"`
	Revision string `yaml:"revision"`
	Reason   string `yaml:"reason"`
}

type versionDriftFile struct {
	Entries []VersionDrift `yaml:"entries"`
	Pins    []PinLag       `yaml:"pins"`
}

// LoadPinLag reads the `pins:` list of tests/gitops/version-drift.yaml.
func LoadPinLag(repoRoot string) ([]PinLag, error) {
	var f versionDriftFile
	if err := readRegistryFile(repoRoot, versionDriftFileName, &f); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for i, e := range f.Pins {
		for field, v := range map[string]string{"file": e.File, "key": e.Key, "revision": e.Revision, "reason": e.Reason} {
			if strings.TrimSpace(v) == "" {
				return nil, fmt.Errorf("%s/%s: pins entry %d has no %s (every lag must name its file, key, revision and reason)",
					GitOpsRegistryDir, versionDriftFileName, i, field)
			}
		}
		id := e.File + "#" + e.Key
		if seen[id] {
			return nil, fmt.Errorf("%s/%s: duplicate pins entry for %s %s", GitOpsRegistryDir, versionDriftFileName, e.File, e.Key)
		}
		seen[id] = true
	}
	return f.Pins, nil
}

// LoadVersionDrift reads tests/gitops/version-drift.yaml (strict decoding; a
// missing file means no entries).
func LoadVersionDrift(repoRoot string) ([]VersionDrift, error) {
	var f versionDriftFile
	if err := readRegistryFile(repoRoot, versionDriftFileName, &f); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for i, e := range f.Entries {
		for field, v := range map[string]string{"application": e.Application, "chart": e.Chart, "revision": e.Revision, "reason": e.Reason} {
			if strings.TrimSpace(v) == "" {
				return nil, fmt.Errorf("%s/%s: entry %d has no %s (every exception must name its Application, chart, revision and reason)",
					GitOpsRegistryDir, versionDriftFileName, i, field)
			}
		}
		id := e.Application + "/" + e.Chart
		if seen[id] {
			return nil, fmt.Errorf("%s/%s: duplicate entry for application %q chart %q", GitOpsRegistryDir, versionDriftFileName, e.Application, e.Chart)
		}
		seen[id] = true
	}
	return f.Entries, nil
}

// VersionPins is the charts: map of configuration/versions.yaml plus the
// Renovate depName each key carries in its `# renovate:` marker.
type VersionPins struct {
	Charts map[string]string
	// DepNames maps a charts: key to the last path segment of its marker's
	// depName (argo-cd for argocd, connect for onepassword-connect).
	DepNames map[string]string
}

var renovateMarker = regexp.MustCompile(`#\s*renovate:.*\bdepName=(\S+)`)
var versionsKey = regexp.MustCompile(`^\s+([\w.-]+):\s*`)

// LoadVersionPins reads configuration/versions.yaml.
func LoadVersionPins(repoRoot string) (*VersionPins, error) {
	path := filepath.Join(repoRoot, "configuration", "versions.yaml")
	v, err := config.LoadVersions(path)
	if err != nil {
		return nil, err
	}
	pins := &VersionPins{Charts: v.Charts, DepNames: map[string]string{}}
	if pins.Charts == nil {
		pins.Charts = map[string]string{}
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	section, dep := "", ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, " ") && strings.HasSuffix(strings.TrimSpace(line), ":") {
			section, dep = strings.TrimSuffix(strings.TrimSpace(line), ":"), ""
			continue
		}
		if m := renovateMarker.FindStringSubmatch(line); m != nil {
			dep = m[1]
			continue
		}
		if m := versionsKey.FindStringSubmatch(line); m != nil {
			if section == "charts" && dep != "" {
				pins.DepNames[m[1]] = dep[strings.LastIndex(dep, "/")+1:]
			}
			dep = ""
		}
	}
	return pins, sc.Err()
}

// keysFor returns the charts: keys an Application chart source maps to: the
// key named like the chart, like the Renovate depName, or like the
// Application.
func (p *VersionPins) keysFor(app, chart string) []string {
	var keys []string
	for k := range p.Charts {
		if k == chart || p.DepNames[k] == chart || k == app {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// hasValue reports whether any charts: value equals rev.
func (p *VersionPins) hasValue(rev string) bool {
	for _, v := range p.Charts {
		if v == rev {
			return true
		}
	}
	return false
}

// CheckVersions (versions/<env>) proves that every chart-sourced Application
// renders the chart version configuration/versions.yaml pins. The pin is the
// charts: key mapped by chart name, Renovate depName or Application name;
// without one, the revision must equal some charts: value. Exact string match.
// Drift listed in tests/gitops/version-drift.yaml is allowed; a listed entry
// that no longer matches the render fails. used records the entries this env
// exercised.
func CheckVersions(env string, docs []Doc, pins *VersionPins, drift []VersionDrift, used map[int]bool) Check {
	start := time.Now()
	name := "versions/" + env
	srcs := chartSources(docs)

	var findings []string
	matched, allowed := 0, 0
	for _, key := range sortedKeys(srcs) {
		s := srcs[key]
		rev := s.TargetRevision
		keys := pins.keysFor(s.App, s.Chart)
		match := false
		var want []string
		for _, k := range keys {
			want = append(want, fmt.Sprintf("%s (key %s)", pins.Charts[k], k))
			if pins.Charts[k] == rev {
				match = true
			}
		}
		if len(keys) == 0 {
			match = pins.hasValue(rev)
		}

		entry := -1
		for i, e := range drift {
			if e.Application == s.App && e.Chart == s.Chart {
				entry = i
				break
			}
		}

		switch {
		case entry >= 0 && match:
			used[entry] = true
			findings = append(findings, fmt.Sprintf("%s: chart %s renders %s, which matches configuration/versions.yaml; remove its stale %s/%s entry",
				s.App, s.Chart, rev, GitOpsRegistryDir, versionDriftFileName))
		case entry >= 0 && drift[entry].Revision != rev:
			used[entry] = true
			findings = append(findings, fmt.Sprintf("%s: chart %s renders %s, but %s/%s allows %s; update or remove the entry",
				s.App, s.Chart, rev, GitOpsRegistryDir, versionDriftFileName, drift[entry].Revision))
		case entry >= 0:
			used[entry] = true
			allowed++
		case match:
			matched++
		case len(keys) == 0:
			findings = append(findings, fmt.Sprintf("%s: chart %s renders %s, versions.yaml has no charts: key for it (by chart, Renovate depName or Application name) and no value equal to %s",
				s.App, s.Chart, rev, rev))
		default:
			findings = append(findings, fmt.Sprintf("%s: chart %s renders %s, versions.yaml has %s", s.App, s.Chart, rev, strings.Join(want, " or ")))
		}
	}

	if len(findings) > 0 {
		return FailCheck(name, start,
			fmt.Sprintf("%d chart source(s) drift from configuration/versions.yaml charts:; make the template read the pin, or register the drift with a reason in %s/%s",
				len(findings), GitOpsRegistryDir, versionDriftFileName),
			findings...)
	}
	return PassCheck(name, start, fmt.Sprintf("%d chart source(s) match configuration/versions.yaml; %d allowed by %s/%s",
		matched, allowed, GitOpsRegistryDir, versionDriftFileName))
}

// pinSource is one committed file that pins a version outside the render path,
// where versions/<env> cannot see it: Terragrunt inputs (what the cluster
// runs) and the plain-Helm bootstrap chart (what ArgoCD self-manages). Each
// pattern's first capture group is the pinned value.
type pinSource struct {
	file    string // repo-relative
	pattern *regexp.Regexp
	section string // versions.yaml section: tools, charts or images
	key     string
}

var pinSources = []pinSource{
	{"terragrunt/environments/homelab/env.hcl", regexp.MustCompile(`(?m)^\s*talos_version\s*=\s*"([^"]+)"`), "tools", "talos"},
	{"terragrunt/environments/homelab/env.hcl", regexp.MustCompile(`(?m)^\s*kubernetes_version\s*=\s*"([^"]+)"`), "tools", "kubernetes"},
	{"charts/bootstrap/values.yaml", regexp.MustCompile(`(?m)^\s*name:\s*argo-cd\s*\n(?:.*\n)?\s*version:\s*"([^"]+)"`), "charts", "argocd"},
	{"charts/bootstrap/values.yaml", regexp.MustCompile(`ghcr\.io/ryanmcafee/homelab-cmp:([\w.-]+)`), "images", "homelab-cmp"},
}

// CheckPins (versions/pins) compares the version pins that live outside the
// rendered manifests with configuration/versions.yaml: the Talos and
// Kubernetes versions Terragrunt applies, the ArgoCD chart the bootstrap chart
// self-manages, and every homelab-cmp image tag in it. Renovate bumps
// versions.yaml alone, so without this check a bump could advertise a version
// production never runs (the README badges are rendered from versions.yaml).
func CheckPins(repoRoot string) Check {
	start := time.Now()
	const name = "versions/pins"
	v, err := config.LoadVersions(filepath.Join(repoRoot, "configuration", "versions.yaml"))
	if err != nil {
		return FailCheck(name, start, "loading configuration/versions.yaml", err.Error())
	}
	sections := map[string]map[string]string{"tools": v.Tools, "charts": v.Charts, "images": v.Images}
	lags, err := LoadPinLag(repoRoot)
	if err != nil {
		return FailCheck(name, start, "loading "+GitOpsRegistryDir+"/"+versionDriftFileName, err.Error())
	}
	lagIndex := map[string]int{}
	for i, l := range lags {
		lagIndex[l.File+"#"+l.Key] = i
	}
	usedLag := map[int]bool{}

	var findings []string
	checked, lagging := 0, 0
	for _, s := range pinSources {
		body, err := os.ReadFile(filepath.Join(repoRoot, filepath.FromSlash(s.file)))
		if err != nil {
			findings = append(findings, fmt.Sprintf("%s: %v", s.file, err))
			continue
		}
		want := sections[s.section][s.key]
		if want == "" {
			findings = append(findings, fmt.Sprintf("configuration/versions.yaml has no %s.%s (pinned by %s)", s.section, s.key, s.file))
			continue
		}
		matches := s.pattern.FindAllStringSubmatch(string(body), -1)
		if len(matches) == 0 {
			findings = append(findings, fmt.Sprintf("%s: no pin found for %s.%s", s.file, s.section, s.key))
			continue
		}
		key := s.section + "." + s.key
		for _, m := range matches {
			checked++
			if m[1] == want {
				continue
			}
			if i, ok := lagIndex[s.file+"#"+key]; ok && lags[i].Revision == m[1] {
				// A registered lag: the upgrade is in progress and documented.
				usedLag[i] = true
				lagging++
				continue
			}
			findings = append(findings, fmt.Sprintf("%s pins %s at %s, configuration/versions.yaml has %s (register the lag with a reason in %s/%s pins: if an upgrade is pending)",
				s.file, key, m[1], want, GitOpsRegistryDir, versionDriftFileName))
		}
	}
	// A lag entry the files no longer exhibit is stale: the upgrade landed (remove
	// it) or the pin moved somewhere else (update it).
	for i, l := range lags {
		if !usedLag[i] {
			findings = append(findings, fmt.Sprintf("%s/%s pins entry %s %s at %s matches nothing: %s no longer carries that value",
				GitOpsRegistryDir, versionDriftFileName, l.File, l.Key, l.Revision, l.File))
		}
	}
	if len(findings) > 0 {
		return FailCheck(name, start, fmt.Sprintf("%d pin(s) disagree with configuration/versions.yaml", len(findings)), findings...)
	}
	if lagging > 0 {
		return PassCheck(name, start, fmt.Sprintf("%d pin(s) outside the render path checked against configuration/versions.yaml; %d lag behind it under a registered reason (%s/%s pins:)",
			checked, lagging, GitOpsRegistryDir, versionDriftFileName))
	}
	return PassCheck(name, start, fmt.Sprintf("%d pin(s) outside the render path match configuration/versions.yaml", checked))
}

// VersionChecks runs CheckVersions for every rendered env plus CheckPins.
// complete says the render covered every environment, which is when an entry
// that matched no Application anywhere is reported (versions/registry) as
// stale.
func VersionChecks(repoRoot string, rendered map[string]map[string][]Doc, envs []Env, complete bool) []Check {
	start := time.Now()
	pins, err := LoadVersionPins(repoRoot)
	if err != nil {
		return []Check{FailCheck("versions/registry", start, "loading configuration/versions.yaml", err.Error())}
	}
	drift, err := LoadVersionDrift(repoRoot)
	if err != nil {
		return []Check{FailCheck("versions/registry", start, "loading "+GitOpsRegistryDir+"/"+versionDriftFileName, err.Error())}
	}

	used := map[int]bool{}
	checks := []Check{CheckPins(repoRoot)}
	for _, env := range envs {
		byChart := rendered[env.Name]
		var docs []Doc
		for _, chart := range sortedKeys(byChart) {
			docs = append(docs, byChart[chart]...)
		}
		checks = append(checks, CheckVersions(env.Name, docs, pins, drift, used))
	}

	if complete {
		var stale []string
		for i, e := range drift {
			if !used[i] {
				stale = append(stale, fmt.Sprintf("%s (chart %s, revision %s): no rendered Application in any environment; remove the entry", e.Application, e.Chart, e.Revision))
			}
		}
		if len(stale) > 0 {
			checks = append(checks, FailCheck("versions/registry", start,
				fmt.Sprintf("%d stale %s/%s entr(y/ies)", len(stale), GitOpsRegistryDir, versionDriftFileName), stale...))
		}
	}
	return checks
}
