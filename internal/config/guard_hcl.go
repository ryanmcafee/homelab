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

// hclIdentityNames are the snake_case keys terragrunt/environments/*/env.hcl
// resolves out of the ConfigSet that no prefix or suffix rule reaches. The
// ConfigSet key and the HCL key rarely share a name - LAN_CIDR is written
// subnet, LB_POOL_START is lb_pool_start - so the value rule covers them and
// the shape rule, the half that runs in a clone with no homelab.yaml, did not.
var hclIdentityNames = map[string]bool{
	"subnet":        true,
	"dns_servers":   true,
	"lb_pool_start": true,
	"lb_pool_end":   true,
	"endpoint":      true,
	"node_name":     true,
}

// hclIdentitySuffixes mirror how HCL prefixes an identity by subsystem rather
// than suffixing it: proxmox_host, cluster_endpoint, host_node, local_dns_domain. An explicit
// name list would go stale the first time a unit adds another subsystem.
var hclIdentitySuffixes = []string{"_FQDN", "_GATEWAY", "_IP_ADDRESS", "_HOST", "_ENDPOINT", "_NODE", "_DOMAIN"}

func hclIdentityKey(key string) bool {
	upper := strings.ToUpper(key)
	if IsPIIKey(upper) || chartPIIKeys[chartKeyName(key)] || hclIdentityNames[chartKeyName(key)] {
		return true
	}
	if upper == "FQDN" || upper == "GATEWAY" {
		return true
	}
	for _, suffix := range hclIdentitySuffixes {
		if strings.HasSuffix(upper, suffix) {
			return true
		}
	}
	return false
}

// HCL is parsed without an evaluation context: variable traversals and function
// calls remain unresolved, while literal assignments and variable defaults can
// be checked without Terraform, providers, credentials, or a cluster.
var _, sharedAddressSpace, _ = net.ParseCIDR("100.64.0.0/10")

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
	var judge func(string, hclsyntax.Expression)
	judge = func(key string, expr hclsyntax.Expression) {
		if !hclIdentityKey(key) {
			return
		}
		// dns_servers = [local.config.DNS_SERVER_IP, "10.23.1.1"] evaluates to
		// nothing as a whole, because one element is an unresolved traversal.
		// Judging each element keeps the literal visible.
		if list, ok := expr.(*hclsyntax.TupleConsExpr); ok {
			for _, element := range list.Exprs {
				judge(key, element)
			}
			return
		}
		value, diags := expr.Value(nil)
		if diags.HasErrors() || !value.IsKnown() || value.IsNull() || value.Type() != cty.String {
			return
		}
		text := value.AsString()
		kind := classifyHostValue(text)
		// A host address carrying a netmask (10.23.1.4/24) is still a host
		// address. A private network (10.244.0.0/16) is left to the value rule:
		// shape cannot tell the operator's LAN from Kind's fork-invariant pod
		// network. A public network names someone's allocation, so shape owns it.
		// RFC 6598 shared space is every tailnet's range, so it is not public.
		if ip, network, err := net.ParseCIDR(text); err == nil && IsRoutableHostIP(ip.String()) {
			switch {
			case !ip.Equal(network.IP):
				kind = "routable host IP with prefix"
			case !ip.IsPrivate() && !sharedAddressSpace.Contains(ip):
				kind = "public network CIDR"
			}
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
