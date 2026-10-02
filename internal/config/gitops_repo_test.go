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
		errHas   string
		errLacks string
		wantNil  bool
		url      string
		cloneURL string
		owner    string
		repo     string
		slug     string
		imgOwner string
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
		{
			name:     "uppercase owner keeps its case but lowercases the image owner",
			value:    "https://github.com/RyanMcAfee/homelab",
			url:      "https://github.com/RyanMcAfee/homelab",
			cloneURL: "https://github.com/RyanMcAfee/homelab.git",
			owner:    "RyanMcAfee", repo: "homelab", slug: "RyanMcAfee/homelab", imgOwner: "ryanmcafee",
		},
		{
			name:     "username without a password",
			value:    "https://git@github.com/forker/homelab",
			url:      "https://git@github.com/forker/homelab",
			cloneURL: "https://git@github.com/forker/homelab.git",
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
		{name: "github web url of a branch", value: "https://github.com/forker/homelab/tree/main", wantErr: true, errHas: "github.com"},
		{name: "github scp form with a nested path", value: "git@github.com:forker/homelab/extra.git", wantErr: true, errHas: "github.com"},
		{name: "query string", value: "https://github.com/forker/homelab?x=1", wantErr: true, errHas: "query or fragment"},
		{name: "fragment", value: "https://github.com/forker/homelab#readme", wantErr: true, errHas: "query or fragment"},
		{name: "query on a self-hosted forge", value: "https://gitlab.example.com/platform/infra/homelab?ref=main", wantErr: true, errHas: "query or fragment"},
		{name: "userinfo with a password", value: "https://user:tok@github.com/forker/homelab", wantErr: true, errHas: "password", errLacks: "tok"},
		{name: "scp form with a password", value: "git:tok@github.com:forker/homelab.git", wantErr: true, errHas: "password", errLacks: "tok"},
		{name: "userinfo with an empty password", value: "https://user:@github.com/forker/homelab", wantErr: true, errHas: "password"},
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
				if c.errHas != "" && !strings.Contains(err.Error(), c.errHas) {
					t.Errorf("error %q does not contain %q", err, c.errHas)
				}
				if c.errLacks != "" && strings.Contains(err.Error(), c.errLacks) {
					t.Errorf("error %q leaks %q", err, c.errLacks)
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
			wantImgOwner := c.imgOwner
			if wantImgOwner == "" {
				wantImgOwner = c.owner
			}
			if got.ImageOwner != wantImgOwner {
				t.Errorf("ImageOwner = %q, want %q", got.ImageOwner, wantImgOwner)
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

	addons, apps := renderHelmTemplatesWithRepo(t, repoURL)

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

// TestTriageAgentImageOwnerIsLowercase pins the image reference for a GitHub
// login with capitals: OCI repository paths must be lowercase.
func TestTriageAgentImageOwnerIsLowercase(t *testing.T) {
	addons, _ := renderHelmTemplatesWithRepo(t, "https://github.com/RyanMcAfee/homelab")
	if !strings.Contains(addons, `image: "ghcr.io/ryanmcafee/homelab-triage-agent:`) {
		t.Errorf("triage agent image does not use the lowercased owner")
	}
	if strings.Contains(addons, "ghcr.io/RyanMcAfee/") {
		t.Errorf("triage agent image still renders the owner with capitals")
	}
}

// renderHelmTemplatesWithRepo renders helm-addons.tmpl and helm-apps.tmpl from
// homelab.yaml.example with GITOPS_REPO_URL replaced by repoURL.
func renderHelmTemplatesWithRepo(t *testing.T, repoURL string) (addons, apps string) {
	t.Helper()
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

	addons, err = Export(rc, filepath.Join(configRoot, "templates", "helm-addons.tmpl"))
	if err != nil {
		t.Fatalf("export helm-addons.tmpl: %v", err)
	}
	apps, err = Export(rc, filepath.Join(configRoot, "templates", "helm-apps.tmpl"))
	if err != nil {
		t.Fatalf("export helm-apps.tmpl: %v", err)
	}
	return addons, apps
}
