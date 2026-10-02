package config

import (
	"strings"
	"testing"
)

// The previews ApplicationSet's pull-request generator authenticates with the
// Secret previews.github.tokenSecret.name, produced by a OnePasswordItem in the
// gitops chart. Anonymous polling shares the per-egress-IP 60/hour quota with
// every other anonymous GitHub caller in the cluster; once it runs out the
// ApplicationSet goes ErrorOccurred and degrades the gitops Application.

// TestPreviewsTokenRequiresItemPath: a token Secret name without an item path
// must fail the render, not produce a tokenRef to a Secret nothing creates.
func TestPreviewsTokenRequiresItemPath(t *testing.T) {
	requireHelm(t)
	root := findProjectRootForTest(t)

	for _, path := range []string{"", "   "} {
		t.Run("path="+strings.TrimSpace(path), func(t *testing.T) {
			out, ok := helmTemplate(t, root, "gitops",
				"--set", "previews.enabled=true",
				"--set-string", "previews.github.tokenSecret.name=previews-github-token",
				"--set-string", "previews.github.tokenSecret.onePasswordItemPath="+path)
			if ok {
				t.Fatalf("gitops rendered a previews token Secret name without an item path:\n%s", out)
			}
			if !strings.Contains(out, "previews.github.tokenSecret.onePasswordItemPath") {
				t.Errorf("error message does not name the missing values key:\n%s", out)
			}
		})
	}
}

// TestPreviewsTokenRendersProducerAndTokenRef: with both set, the chart renders
// exactly one OnePasswordItem for the Secret and the generator references it.
func TestPreviewsTokenRendersProducerAndTokenRef(t *testing.T) {
	requireHelm(t)
	root := findProjectRootForTest(t)

	for _, path := range []string{"vaults/fork-a/items/first-item", "vaults/fork-b/items/second-item"} {
		t.Run(path, func(t *testing.T) {
			out, ok := helmTemplate(t, root, "gitops",
				"--set", "previews.enabled=true",
				"--set-string", "previews.github.tokenSecret.name=previews-github-token",
				"--set-string", "previews.github.tokenSecret.onePasswordItemPath="+path)
			if !ok {
				t.Fatalf("gitops failed to render:\n%s", out)
			}
			if n := strings.Count(out, "kind: OnePasswordItem"); n != 1 {
				t.Errorf("rendered %d OnePasswordItems, want 1:\n%s", n, out)
			}
			for _, want := range []string{
				"name: previews-github-token",
				`itemPath: "` + path + `"`,
				"secretName: previews-github-token",
			} {
				if !strings.Contains(out, want) {
					t.Errorf("render does not contain %q:\n%s", want, out)
				}
			}
		})
	}
}

// TestPreviewsAnonymousRendersNoProducer keeps the empty default (Kind,
// localdev) rendering neither a OnePasswordItem nor a tokenRef.
func TestPreviewsAnonymousRendersNoProducer(t *testing.T) {
	requireHelm(t)
	root := findProjectRootForTest(t)

	for _, enabled := range []string{"true", "false"} {
		t.Run("enabled="+enabled, func(t *testing.T) {
			out, ok := helmTemplate(t, root, "gitops", "--set", "previews.enabled="+enabled)
			if !ok {
				t.Fatalf("gitops failed to render:\n%s", out)
			}
			if strings.Contains(out, "kind: OnePasswordItem") || strings.Contains(out, "tokenRef:") {
				t.Errorf("anonymous previews rendered a token producer or tokenRef:\n%s", out)
			}
		})
	}
}
