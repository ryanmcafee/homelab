package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
)

// A PCI address or IOMMU group in env.hcl describes one machine, so every passthrough local reads hardware.hcl.
func TestHomelabEnvHCLReadsPassthroughFromHardwareFile(t *testing.T) {
	envDir := filepath.Join(findProjectRootForTest(t), "terragrunt", "environments", "homelab")
	locals := parseHCLLocals(t, filepath.Join(envDir, "env.hcl"))

	for _, name := range []string{"gpu_pci_id", "gpu_device", "gpu_intel_pci_id", "gpu_intel_device", "hba_devices"} {
		t.Run(name, func(t *testing.T) {
			expr, ok := locals[name]
			if !ok {
				t.Fatalf("env.hcl: locals.%s is not declared", name)
			}
			if !referencesLocal(expr, "hardware") {
				t.Fatalf("env.hcl: locals.%s must be read from local.hardware, not written as a literal", name)
			}
		})
	}
}

func TestHardwareHCLExampleDeclaresNoDevices(t *testing.T) {
	envDir := filepath.Join(findProjectRootForTest(t), "terragrunt", "environments", "homelab")
	locals := parseHCLLocals(t, filepath.Join(envDir, "hardware.hcl.example"))

	for _, name := range []string{"gpu_devices", "hba_devices"} {
		t.Run(name, func(t *testing.T) {
			expr, ok := locals[name]
			if !ok {
				t.Fatalf("hardware.hcl.example: locals.%s is not declared", name)
			}
			object, ok := expr.(*hclsyntax.ObjectConsExpr)
			if !ok || len(object.Items) != 0 {
				t.Fatalf("hardware.hcl.example: locals.%s must be {} so a fork's copy passes nothing through", name)
			}
		})
	}
}

func parseHCLLocals(t *testing.T, path string) map[string]hclsyntax.Expression {
	t.Helper()
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	file, diags := hclsyntax.ParseConfig(source, path, hcl.InitialPos)
	if diags.HasErrors() {
		t.Fatalf("parsing %s: %v", path, diags)
	}
	body, ok := file.Body.(*hclsyntax.Body)
	if !ok {
		t.Fatalf("%s: unexpected body type %T", path, file.Body)
	}
	locals := map[string]hclsyntax.Expression{}
	for _, block := range body.Blocks {
		if block.Type != "locals" {
			continue
		}
		for name, attr := range block.Body.Attributes {
			locals[name] = attr.Expr
		}
	}
	return locals
}

func referencesLocal(expr hclsyntax.Expression, name string) bool {
	for _, traversal := range expr.Variables() {
		if traversal.RootName() != "local" || len(traversal) < 2 {
			continue
		}
		if attr, ok := traversal[1].(hcl.TraverseAttr); ok && attr.Name == name {
			return true
		}
	}
	return false
}
