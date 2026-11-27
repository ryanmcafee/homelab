package config

import (
	"path/filepath"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
)

// A literal here is a second copy of a ConfigSet key that nothing keeps in step with the first.
func TestHomelabEnvHCLReadsConfigSetKeys(t *testing.T) {
	cases := []struct{ local, configKey string }{
		{"gpu_vendor", "GPU_VENDOR"},
	}

	path := filepath.Join(findProjectRootForTest(t), "terragrunt", "environments", "homelab", "env.hcl")
	locals := parseHCLLocals(t, path)

	for _, tc := range cases {
		t.Run(tc.local, func(t *testing.T) {
			expr, ok := locals[tc.local]
			if !ok {
				t.Fatalf("%s: locals.%s is not declared", path, tc.local)
			}
			traversal, ok := expr.(*hclsyntax.ScopeTraversalExpr)
			if !ok {
				t.Fatalf("%s: locals.%s must be local.config.%s, got a %T", path, tc.local, tc.configKey, expr)
			}
			if got := traversalString(traversal.Traversal); got != "local.config."+tc.configKey {
				t.Fatalf("%s: locals.%s = %s; want local.config.%s", path, tc.local, got, tc.configKey)
			}
		})
	}
}

func traversalString(traversal hcl.Traversal) string {
	out := ""
	for _, step := range traversal {
		switch s := step.(type) {
		case hcl.TraverseRoot:
			out += s.Name
		case hcl.TraverseAttr:
			out += "." + s.Name
		default:
			out += ".?"
		}
	}
	return out
}
