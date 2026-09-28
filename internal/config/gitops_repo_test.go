package config

import (
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeriveGitOpsRepo(t *testing.T) {
	cases := []struct {
		name     string
		value    string
		absent   bool
		wantErr  bool
		wantNil  bool
		url      string
		cloneURL string
		owner    string
		repo     string
		slug     string
	}{
		{
			name:     "https url",
			value:    "https://github.com/ryanmcafee/homelab",
			url:      "https://github.com/ryanmcafee/homelab",
			cloneURL: "https://github.com/ryanmcafee/homelab.git",
			owner:    "ryanmcafee", repo: "homelab", slug: "ryanmcafee/homelab",
		},
		{
			name:     "a fork with its own owner and repository name",
			value:    "https://github.com/forker/my-homelab",
			url:      "https://github.com/forker/my-homelab",
			cloneURL: "https://github.com/forker/my-homelab.git",
			owner:    "forker", repo: "my-homelab", slug: "forker/my-homelab",
		},
		{
			name:     "trailing .git is not doubled",
			value:    "https://github.com/forker/homelab.git",
			url:      "https://github.com/forker/homelab",
			cloneURL: "https://github.com/forker/homelab.git",
			owner:    "forker", repo: "homelab", slug: "forker/homelab",
		},
		{
			name:     "trailing slash",
			value:    "https://github.com/forker/homelab/",
			url:      "https://github.com/forker/homelab",
			cloneURL: "https://github.com/forker/homelab.git",
			owner:    "forker", repo: "homelab", slug: "forker/homelab",
		},
		{
			name:     "surrounding whitespace",
			value:    "  https://github.com/forker/homelab  ",
			url:      "https://github.com/forker/homelab",
			cloneURL: "https://github.com/forker/homelab.git",
			owner:    "forker", repo: "homelab", slug: "forker/homelab",
		},
		{
			name:     "ssh scp form",
			value:    "git@github.com:forker/homelab.git",
			url:      "git@github.com:forker/homelab",
			cloneURL: "git@github.com:forker/homelab.git",
			owner:    "forker", repo: "homelab", slug: "forker/homelab",
		},
		{
			name:     "self-hosted forge with a nested group",
			value:    "https://gitlab.example.com/platform/infra/homelab",
			url:      "https://gitlab.example.com/platform/infra/homelab",
			cloneURL: "https://gitlab.example.com/platform/infra/homelab.git",
			owner:    "platform/infra", repo: "homelab", slug: "platform/infra/homelab",
		},
		{
			name:     "non-default port",
			value:    "https://git.example.com:8443/forker/homelab",
			url:      "https://git.example.com:8443/forker/homelab",
			cloneURL: "https://git.example.com:8443/forker/homelab.git",
			owner:    "forker", repo: "homelab", slug: "forker/homelab",
		},
		{name: "key absent", absent: true, wantNil: true},
		{name: "empty value", value: "", wantNil: true},
		{name: "whitespace-only value", value: "   ", wantNil: true},
		{name: "host with no path", value: "https://github.com", wantErr: true},
		{name: "host with a trailing slash and no path", value: "https://github.com/", wantErr: true},
		{name: "owner but no repository", value: "https://github.com/forker", wantErr: true},
		// No scheme means the host is indistinguishable from a nested group:
		// this would otherwise parse its owner as "github.com/forker".
		{name: "no scheme", value: "github.com/forker/homelab", wantErr: true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			values := map[string]string{}
			if !c.absent {
				values[GitOpsRepoKey] = c.value
			}

			got, err := DeriveGitOpsRepo(values)
			if c.wantErr {
				if err == nil {
					t.Fatalf("DeriveGitOpsRepo(%q) = %+v, want an error", c.value, got)
				}
				if !strings.Contains(err.Error(), GitOpsRepoKey) {
					t.Errorf("error %q does not name %s, so an operator cannot tell which key to fix", err, GitOpsRepoKey)
				}
				return
			}
			if err != nil {
				t.Fatalf("DeriveGitOpsRepo(%q): %v", c.value, err)
			}
			if c.wantNil {
				if got != nil {
					t.Fatalf("DeriveGitOpsRepo(%q) = %+v, want nil", c.value, got)
				}
				return
			}
			if got == nil {
				t.Fatalf("DeriveGitOpsRepo(%q) = nil, want a parsed repository", c.value)
			}
			if got.URL != c.url {
				t.Errorf("URL = %q, want %q", got.URL, c.url)
			}
			if got.CloneURL != c.cloneURL {
				t.Errorf("CloneURL = %q, want %q", got.CloneURL, c.cloneURL)
			}
			if got.Owner != c.owner {
				t.Errorf("Owner = %q, want %q", got.Owner, c.owner)
			}
			if got.Name != c.repo {
				t.Errorf("Name = %q, want %q", got.Name, c.repo)
			}
			if got.Slug != c.slug {
				t.Errorf("Slug = %q, want %q", got.Slug, c.slug)
			}
		})
	}
}

// TestHelmTemplatesTakeTheRepoFromConfig renders both helm templates with a
// GITOPS_REPO_URL that is neither the upstream owner nor the upstream
// repository name, and asserts every repository-derived string in the output
// followed it.
//
// A fork that fills in its ConfigSet correctly used to get an ArgoCD that
// synced github.com/ryanmcafee/homelab — healthy, and somebody else's git
// history. This is the assertion that a literal owner cannot pass.
func TestHelmTemplatesTakeTheRepoFromConfig(t *testing.T) {
	const (
		repoURL = "https://github.com/forker/my-homelab"
		owner   = "forker"
		slug    = "forker/my-homelab"
	)

	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	schema, err := LoadSchemaDir(filepath.Join(configRoot, "schema"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}
	versions, err := LoadVersions(filepath.Join(configRoot, "versions.yaml"))
	if err != nil {
		t.Fatalf("loading versions: %v", err)
	}
	defaults, err := LoadEnvironment(filepath.Join(configRoot, "environments", "defaults.yaml"))
	if err != nil {
		t.Fatalf("loading defaults: %v", err)
	}
	env, err := LoadEnvironment(filepath.Join(configRoot, "environments", "homelab.yaml.example"))
	if err != nil {
		t.Fatalf("loading homelab.yaml.example: %v", err)
	}
	env[GitOpsRepoKey] = repoURL

	rc, err := Eval(schema, versions, "homelab", defaults, env)
	if err != nil {
		t.Fatalf("eval: %v", err)
	}

	addons, err := Export(rc, filepath.Join(configRoot, "templates", "helm-addons.tmpl"))
	if err != nil {
		t.Fatalf("export helm-addons.tmpl: %v", err)
	}
	apps, err := Export(rc, filepath.Join(configRoot, "templates", "helm-apps.tmpl"))
	if err != nil {
		t.Fatalf("export helm-apps.tmpl: %v", err)
	}

	cases := []struct {
		name   string
		output string
		want   string
	}{
		{"addons repoUrl", addons, "repoUrl: " + repoURL + ".git"},
		{"apps repoUrl", apps, "repoUrl: " + repoURL + ".git"},
		{"unreviewed PR query owner", addons, url.QueryEscape("user:" + owner)},
		{"review-requested PR query owner", addons, url.QueryEscape("review-requested:" + owner)},
		{"triage agent image owner", addons, "ghcr.io/" + owner + "/homelab-triage-agent:"},
		{"triage agent repo slug", addons, `repoSlug: "` + slug + `"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if !strings.Contains(c.output, c.want) {
				t.Errorf("rendered output does not contain %q — the template is not reading %s", c.want, GitOpsRepoKey)
			}
		})
	}

	// Nothing may name the upstream account once the set names another one.
	for _, o := range []struct {
		name   string
		output string
	}{{"helm-addons.tmpl", addons}, {"helm-apps.tmpl", apps}} {
		for _, line := range strings.Split(o.output, "\n") {
			if strings.Contains(line, "ryanmcafee") {
				t.Errorf("%s still renders the upstream owner with %s=%q: %s", o.name, GitOpsRepoKey, repoURL, line)
			}
		}
	}
}
