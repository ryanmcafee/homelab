package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"
)

func isGuardHCL(path string) bool {
	name := strings.ToLower(path)
	for _, suffix := range templateFileSuffixes {
		name = strings.TrimSuffix(name, suffix)
	}
	switch filepath.Ext(name) {
	case ".hcl", ".tf", ".tfvars":
		return true
	}
	return false
}

func hclIdentityKey(key string) bool {
	upper := strings.ToUpper(key)
	return IsPIIKey(upper) || chartPIIKeys[chartKeyName(key)] ||
		upper == "FQDN" || strings.HasSuffix(upper, "_FQDN") ||
		upper == "GATEWAY" || strings.HasSuffix(upper, "_GATEWAY") ||
		strings.HasSuffix(upper, "_IP_ADDRESS")
}

// HCL is parsed without an evaluation context: variable traversals and function
// calls remain unresolved, while literal assignments and variable defaults can
// be checked without Terraform, providers, credentials, or a cluster.
func scanHCLShape(path string) (GuardResult, error) {
	result := GuardResult{File: path}
	source, err := os.ReadFile(path)
	if err != nil {
		return result, err
	}
	file, diagnostics := hclsyntax.ParseConfig(source, path, hcl.InitialPos)
	if diagnostics.HasErrors() {
		return result, fmt.Errorf("parse HCL: %s", diagnostics.Error())
	}
	lines := strings.Split(string(source), "\n")
	seen := map[int]bool{}
	judge := func(key string, expr hclsyntax.Expression) {
		if !hclIdentityKey(key) {
			return
		}
		value, diags := expr.Value(nil)
		if diags.HasErrors() || !value.IsKnown() || value.IsNull() || value.Type() != cty.String {
			return
		}
		text := value.AsString()
		kind := classifyHostValue(text)
		if ip, _, err := net.ParseCIDR(text); err == nil && isRoutableHostIP(ip.String()) {
			kind = "routable host IP with prefix"
		}
		if IsTemplateFile(path) {
			if isExamplePlaceholder(text) {
				return
			}
			kind = "non-placeholder value in example file"
		}
		if kind == "" {
			return
		}
		line := expr.Range().Start.Line
		if seen[line] {
			return
		}
		seen[line] = true
		result.Matches = append(result.Matches, GuardMatch{Line: line, Pattern: key + " (" + kind + ")", Content: lines[line-1]})
	}
	var walk func(*hclsyntax.Body, string)
	walk = func(body *hclsyntax.Body, variable string) {
		for key, attr := range body.Attributes {
			if key == "default" && variable != "" {
				key = variable
			}
			judge(key, attr.Expr)
			hclsyntax.VisitAll(attr.Expr, func(node hclsyntax.Node) hcl.Diagnostics {
				if object, ok := node.(*hclsyntax.ObjectConsExpr); ok {
					for _, item := range object.Items {
						key, diags := item.KeyExpr.Value(nil)
						if !diags.HasErrors() && key.IsKnown() && !key.IsNull() && key.Type() == cty.String {
							judge(key.AsString(), item.ValueExpr)
						}
					}
				}
				return nil
			})
		}
		for _, block := range body.Blocks {
			name := ""
			if block.Type == "variable" && len(block.Labels) == 1 {
				name = block.Labels[0]
			}
			walk(block.Body, name)
		}
	}
	walk(file.Body.(*hclsyntax.Body), "")
	sort.Slice(result.Matches, func(i, j int) bool { return result.Matches[i].Line < result.Matches[j].Line })
	return result, nil
}
