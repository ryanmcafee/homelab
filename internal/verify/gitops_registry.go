package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// GitOpsRegistryDir is the repo-relative directory holding the linter's
// declarative registries. Every file in it is optional; an absent file means
// "no entries" (except system namespaces, which fall back to defaults).
const GitOpsRegistryDir = "tests/gitops"

// DefaultSystemNamespaces are namespaces the cluster always provides, so an
// Application may target them without a rendered Namespace or
// CreateNamespace=true.
var DefaultSystemNamespaces = []string{"argocd", "default", "kube-public", "kube-system"}

// appFamilyKinds are the argoproj.io kinds that make up the GitOps control
// plane itself. They are never ordered against a CRD provider: the CRDs come
// from ArgoCD, which is installed before anything this repo renders.
var appFamilyKinds = map[string]bool{"Application": true, "AppProject": true, "ApplicationSet": true}

// CRDProvider names the ArgoCD Application that installs the CRDs for one API
// group. Most groups need only a name, which is why the YAML accepts either
//
//	cert-manager.io: cert-manager
//
// or the expanded form
//
//	argoproj.io:
//	  app: argo-workflows
//	  skipKinds: [Application, AppProject, ApplicationSet]
//	  kinds:
//	    Rollout: argo-rollouts
type CRDProvider struct {
	// App is the default provider Application name for the group.
	App string `yaml:"app"`
	// Kinds overrides App for individual kinds in the group.
	Kinds map[string]string `yaml:"kinds"`
	// SkipKinds are kinds in the group that are not ordered at all.
	SkipKinds []string `yaml:"skipKinds"`
}

// UnmarshalYAML accepts both the scalar shorthand and the mapping form.
func (p *CRDProvider) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.ScalarNode {
		var app string
		if err := value.Decode(&app); err != nil {
			return err
		}
		p.App = app
		return nil
	}
	// Decode into a twin type to avoid recursing into this method.
	type plain struct {
		App       string            `yaml:"app"`
		Kinds     map[string]string `yaml:"kinds"`
		SkipKinds []string          `yaml:"skipKinds"`
	}
	var q plain
	if err := value.Decode(&q); err != nil {
		return err
	}
	p.App, p.Kinds, p.SkipKinds = q.App, q.Kinds, q.SkipKinds
	return nil
}

// AppFor returns the provider Application name for a kind in this group.
func (p CRDProvider) AppFor(kind string) string {
	if a, ok := p.Kinds[kind]; ok {
		return a
	}
	return p.App
}

// Skips reports whether a kind is exempt from CR ordering.
func (p CRDProvider) Skips(kind string) bool {
	for _, k := range p.SkipKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// KnownSecret is a Secret consumed by the rendered graph but produced outside
// it (an upstream Helm chart, an operator, or the SOPS/ksops bootstrap).
// Namespace may be "*" (or empty) to match any namespace. Reason is mandatory
// so every exception stays auditable.
type KnownSecret struct {
	Name      string `yaml:"name"`
	Namespace string `yaml:"namespace"`
	Reason    string `yaml:"reason"`
}

// Matches reports whether the entry covers ns/name.
func (k KnownSecret) Matches(ns, name string) bool {
	if k.Name != name {
		return false
	}
	return k.Namespace == "" || k.Namespace == "*" || k.Namespace == ns
}

// GitOpsRegistry is the declarative input to LintGitOps: the facts about the
// cluster and the upstream ecosystem that cannot be derived from the rendered
// manifests alone.
type GitOpsRegistry struct {
	// CRDProviders maps an API group to the Application installing its CRDs.
	CRDProviders map[string]CRDProvider
	// HugeCRDCharts are Application names (or spec.source.chart values) whose
	// CRDs exceed the client-side apply annotation limit and therefore require
	// ServerSideApply=true.
	HugeCRDCharts []string
	// KnownSecrets are accepted secret producers outside the rendered charts.
	KnownSecrets []KnownSecret
	// SystemNamespaces always exist in the cluster.
	SystemNamespaces []string
}

// crdProvidersFile is tests/gitops/crd-providers.yaml. systemNamespaces lives
// here too: both describe cluster-level facts the rendered manifests cannot
// state, and keeping them together avoids a fourth almost-empty file.
type crdProvidersFile struct {
	Providers        map[string]CRDProvider `yaml:"providers"`
	SystemNamespaces []string               `yaml:"systemNamespaces"`
}

type hugeCRDChartsFile struct {
	Charts []string `yaml:"charts"`
}

type knownSecretsFile struct {
	Secrets []KnownSecret `yaml:"secrets"`
}

// LoadGitOpsRegistry reads <repoRoot>/tests/gitops/*.yaml. Missing files are
// not an error; malformed files and incomplete entries are.
func LoadGitOpsRegistry(repoRoot string) (*GitOpsRegistry, error) {
	reg := &GitOpsRegistry{
		CRDProviders:     map[string]CRDProvider{},
		SystemNamespaces: append([]string(nil), DefaultSystemNamespaces...),
	}

	var providers crdProvidersFile
	if err := readRegistryFile(repoRoot, "crd-providers.yaml", &providers); err != nil {
		return nil, err
	}
	for group, p := range providers.Providers {
		if strings.TrimSpace(group) == "" {
			return nil, fmt.Errorf("%s/crd-providers.yaml: empty API group key", GitOpsRegistryDir)
		}
		if strings.TrimSpace(p.App) == "" && len(p.Kinds) == 0 {
			return nil, fmt.Errorf("%s/crd-providers.yaml: provider for group %q has no app and no per-kind overrides", GitOpsRegistryDir, group)
		}
		reg.CRDProviders[group] = p
	}
	if len(providers.SystemNamespaces) > 0 {
		reg.SystemNamespaces = providers.SystemNamespaces
	}

	var huge hugeCRDChartsFile
	if err := readRegistryFile(repoRoot, "huge-crd-charts.yaml", &huge); err != nil {
		return nil, err
	}
	for _, c := range huge.Charts {
		if strings.TrimSpace(c) == "" {
			return nil, fmt.Errorf("%s/huge-crd-charts.yaml: empty chart name", GitOpsRegistryDir)
		}
		reg.HugeCRDCharts = append(reg.HugeCRDCharts, c)
	}

	var known knownSecretsFile
	if err := readRegistryFile(repoRoot, "known-secrets.yaml", &known); err != nil {
		return nil, err
	}
	for i, ks := range known.Secrets {
		if strings.TrimSpace(ks.Name) == "" {
			return nil, fmt.Errorf("%s/known-secrets.yaml: entry %d has no name", GitOpsRegistryDir, i)
		}
		if strings.TrimSpace(ks.Reason) == "" {
			return nil, fmt.Errorf("%s/known-secrets.yaml: entry %q has no reason (every exception must be justified)", GitOpsRegistryDir, ks.Name)
		}
		reg.KnownSecrets = append(reg.KnownSecrets, ks)
	}

	sort.Strings(reg.SystemNamespaces)
	sort.Strings(reg.HugeCRDCharts)
	return reg, nil
}

// readRegistryFile decodes one optional registry file into out.
func readRegistryFile(repoRoot, name string, out any) error {
	path := filepath.Join(repoRoot, filepath.FromSlash(GitOpsRegistryDir), name)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading %s: %w", path, err)
	}
	if err := yaml.Unmarshal(data, out); err != nil {
		return fmt.Errorf("parsing %s: %w", path, err)
	}
	return nil
}

// SystemNamespaceSet returns the system namespaces as a lookup set.
func (r *GitOpsRegistry) SystemNamespaceSet() map[string]bool {
	out := make(map[string]bool, len(r.SystemNamespaces))
	for _, ns := range r.SystemNamespaces {
		out[ns] = true
	}
	return out
}

// HugeCRDChartSet returns the huge-CRD chart names as a lookup set.
func (r *GitOpsRegistry) HugeCRDChartSet() map[string]bool {
	out := make(map[string]bool, len(r.HugeCRDCharts))
	for _, c := range r.HugeCRDCharts {
		out[c] = true
	}
	return out
}

// KnownSecret reports whether ns/name is an accepted external producer.
func (r *GitOpsRegistry) KnownSecret(ns, name string) bool {
	for _, ks := range r.KnownSecrets {
		if ks.Matches(ns, name) {
			return true
		}
	}
	return false
}
