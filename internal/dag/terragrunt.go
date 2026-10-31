// Package dag generates the deployment DAG (ADR-034) from what the repository
// already declares: Terragrunt dependency blocks and ArgoCD sync waves.
package dag

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
)

// Edge records that From must be applied after To.
type Edge struct {
	From string
	To   string
}

// TerragruntGraph is one environment's units and their ordering edges. Units
// without edges are kept: an isolated unit is legal (ADR-034).
type TerragruntGraph struct {
	Env   string
	Units []string
	Edges []Edge
}

// defaultParentFile is what find_in_parent_folders() with no argument resolves.
const defaultParentFile = "terragrunt.hcl"

// ParseTerragrunt reads every unit under terragrunt/environments/<env> without
// evaluating HCL. Any shape that could hide an edge is an error naming its
// file, and every such error is reported rather than only the first.
func ParseTerragrunt(repoRoot, env string) (TerragruntGraph, error) {
	envDir := filepath.Join(repoRoot, "terragrunt", "environments", env)
	units, err := discoverUnits(repoRoot, envDir)
	if err != nil {
		return TerragruntGraph{}, err
	}
	if len(units) == 0 {
		return TerragruntGraph{}, fmt.Errorf("terragrunt/environments/%s has no units (no */terragrunt.hcl)", env)
	}

	p := parser{repoRoot: repoRoot, env: env, envDir: envDir, units: map[string]bool{}, includes: map[string]bool{}}
	for _, u := range units {
		p.units[u] = true
	}
	edges := map[Edge]bool{}
	for _, u := range units {
		for _, to := range p.unitEdges(u) {
			edges[Edge{From: u, To: to}] = true
		}
	}
	if len(p.errs) > 0 {
		return TerragruntGraph{}, errors.Join(p.errs...)
	}

	g := TerragruntGraph{Env: env, Units: units, Edges: make([]Edge, 0, len(edges))}
	for e := range edges {
		g.Edges = append(g.Edges, e)
	}
	sort.Slice(g.Edges, func(i, j int) bool {
		if g.Edges[i].From != g.Edges[j].From {
			return g.Edges[i].From < g.Edges[j].From
		}
		return g.Edges[i].To < g.Edges[j].To
	})
	return g, nil
}

// discoverUnits returns the directories directly under envDir that hold a
// terragrunt.hcl. Terragrunt finds units at any depth, so any other unit file
// below envDir is an error rather than a unit this parse would silently drop.
func discoverUnits(repoRoot, envDir string) ([]string, error) {
	if _, err := os.Stat(envDir); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var units []string
	var errs []error
	err := filepath.WalkDir(envDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != envDir && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() != "terragrunt.hcl" && d.Name() != "terragrunt.hcl.json" {
			return nil
		}
		rel, err := filepath.Rel(envDir, filepath.Dir(path))
		if err != nil {
			return err
		}
		if d.Name() == "terragrunt.hcl" && !strings.Contains(rel, string(filepath.Separator)) && rel != "." {
			units = append(units, rel)
			return nil
		}
		shown, _ := filepath.Rel(repoRoot, path)
		errs = append(errs, fmt.Errorf("%s: unit is not a terragrunt.hcl directly under terragrunt/environments/<env>/<unit>/; terragrunt would run it and this parse would drop its edges", filepath.ToSlash(shown)))
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	sort.Strings(units)
	return units, nil
}

type parser struct {
	repoRoot string
	env      string
	envDir   string
	units    map[string]bool
	includes map[string]bool
	errs     []error
}

func (p *parser) rel(path string) string {
	if r, err := filepath.Rel(p.repoRoot, path); err == nil {
		return filepath.ToSlash(r)
	}
	return path
}

func (p *parser) fail(path, format string, args ...any) {
	p.errs = append(p.errs, fmt.Errorf("%s: %s", p.rel(path), fmt.Sprintf(format, args...)))
}

func parseBody(path string) (*hclsyntax.Body, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	file, diags := hclsyntax.ParseConfig(src, path, hcl.InitialPos)
	if diags.HasErrors() {
		return nil, fmt.Errorf("parse HCL: %s", diags.Error())
	}
	body, ok := file.Body.(*hclsyntax.Body)
	if !ok {
		return nil, fmt.Errorf("parse HCL: unexpected body type %T", file.Body)
	}
	return body, nil
}

func (p *parser) unitEdges(unit string) []string {
	unitDir := filepath.Join(p.envDir, unit)
	path := filepath.Join(unitDir, "terragrunt.hcl")
	body, err := parseBody(path)
	if err != nil {
		p.fail(path, "%v", err)
		return nil
	}
	var targets []string
	addTarget := func(label, raw string) {
		resolved := filepath.Clean(filepath.Join(unitDir, raw))
		name, err := filepath.Rel(p.envDir, resolved)
		if err != nil || strings.Contains(name, string(filepath.Separator)) || !p.units[name] {
			p.fail(path, "%s %q is not a unit of environment %s", label, raw, p.env)
			return
		}
		targets = append(targets, name)
	}
	for _, block := range body.Blocks {
		switch block.Type {
		case "include":
			p.checkInclude(path, unitDir, block)
		case "dependency":
			label := fmt.Sprintf("dependency %q", strings.Join(block.Labels, "."))
			attr, ok := block.Body.Attributes["config_path"]
			if !ok {
				p.fail(path, "%s has no config_path", label)
				continue
			}
			raw, ok := literalString(attr.Expr)
			if !ok {
				p.fail(path, "%s config_path must be a literal string", label)
				continue
			}
			addTarget(label+" config_path", raw)
		case "dependencies":
			attr, ok := block.Body.Attributes["paths"]
			if !ok {
				p.fail(path, "dependencies block has no paths")
				continue
			}
			tuple, ok := attr.Expr.(*hclsyntax.TupleConsExpr)
			if !ok {
				p.fail(path, "dependencies.paths must be a literal list")
				continue
			}
			for i, expr := range tuple.Exprs {
				raw, ok := literalString(expr)
				if !ok {
					p.fail(path, "dependencies.paths[%d] must be a literal string", i)
					continue
				}
				addTarget(fmt.Sprintf("dependencies.paths[%d]", i), raw)
			}
		}
	}
	return targets
}

// checkInclude refuses an included file that declares edges: the per-unit
// parse does not follow include, so it would silently drop them.
func (p *parser) checkInclude(unitPath, unitDir string, block *hclsyntax.Block) {
	label := fmt.Sprintf("include %q", strings.Join(block.Labels, "."))
	attr, ok := block.Body.Attributes["path"]
	if !ok {
		p.fail(unitPath, "%s has no path", label)
		return
	}
	target, ok := p.resolveInclude(unitDir, attr.Expr)
	if !ok {
		p.fail(unitPath, "%s path must be a literal string or find_in_parent_folders()", label)
		return
	}
	if target == "" {
		p.fail(unitPath, "%s: no parent folder holds the included file", label)
		return
	}
	if p.includes[target] {
		return
	}
	p.includes[target] = true
	body, err := parseBody(target)
	if err != nil {
		p.fail(target, "%v", err)
		return
	}
	for _, b := range body.Blocks {
		if b.Type == "dependency" || b.Type == "dependencies" {
			p.fail(target, "included by %s declares %s, which a per-unit parse does not follow; declare it in the unit", p.rel(unitPath), b.Type)
		}
	}
}

// resolveInclude returns the included file, "" when find_in_parent_folders
// finds nothing, and ok=false for any expression it cannot resolve statically.
func (p *parser) resolveInclude(unitDir string, expr hclsyntax.Expression) (string, bool) {
	if raw, ok := literalString(expr); ok {
		return filepath.Clean(filepath.Join(unitDir, raw)), true
	}
	call, ok := expr.(*hclsyntax.FunctionCallExpr)
	if !ok || call.Name != "find_in_parent_folders" || len(call.Args) > 1 {
		return "", false
	}
	name := defaultParentFile
	if len(call.Args) == 1 {
		if name, ok = literalString(call.Args[0]); !ok {
			return "", false
		}
	}
	for dir := filepath.Dir(unitDir); ; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, true
		}
		if dir == p.repoRoot || dir == filepath.Dir(dir) {
			return "", true
		}
	}
}

func literalString(expr hclsyntax.Expression) (string, bool) {
	tmpl, ok := expr.(*hclsyntax.TemplateExpr)
	if !ok || !tmpl.IsStringLiteral() {
		return "", false
	}
	v, diags := tmpl.Value(nil)
	if diags.HasErrors() || !v.IsKnown() || v.IsNull() {
		return "", false
	}
	return v.AsString(), true
}

// Layers groups units into apply order: every unit's dependencies sit in an
// earlier layer. A cycle is an error naming every unit on or behind it.
func (g TerragruntGraph) Layers() ([][]string, error) {
	pending := map[string]int{}
	dependents := map[string][]string{}
	for _, u := range g.Units {
		pending[u] = 0
	}
	for _, e := range g.Edges {
		pending[e.From]++
		dependents[e.To] = append(dependents[e.To], e.From)
	}
	var layers [][]string
	for len(pending) > 0 {
		var ready []string
		for u, n := range pending {
			if n == 0 {
				ready = append(ready, u)
			}
		}
		if len(ready) == 0 {
			stuck := make([]string, 0, len(pending))
			for u := range pending {
				stuck = append(stuck, u)
			}
			sort.Strings(stuck)
			return nil, fmt.Errorf("dependency cycle in environment %s among: %s", g.Env, strings.Join(stuck, ", "))
		}
		sort.Strings(ready)
		for _, u := range ready {
			delete(pending, u)
			for _, d := range dependents[u] {
				pending[d]--
			}
		}
		layers = append(layers, ready)
	}
	return layers, nil
}
