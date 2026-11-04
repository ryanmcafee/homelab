package dag

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

const rootHCL = `remote_state {
  backend = "local"
}
`

const envHCL = `locals {
  environment = "test"
}
`

const includes = `include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path   = find_in_parent_folders("env.hcl")
  expose = true
}
`

// writeTree lays out terragrunt/terragrunt.hcl, terragrunt/environments/test/env.hcl
// and one terragrunt.hcl per unit, returning the repository root.
func writeTree(t *testing.T, units map[string]string, extra map[string]string) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"terragrunt/terragrunt.hcl":               rootHCL,
		"terragrunt/environments/test/env.hcl":    envHCL,
		"terragrunt/environments/other/env.hcl":   envHCL,
		"terragrunt/environments/other/x/ignored": "",
	}
	for unit, body := range units {
		files[filepath.Join("terragrunt/environments/test", unit, "terragrunt.hcl")] = includes + body
	}
	for path, body := range extra {
		files[path] = body
	}
	for path, body := range files {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestParseTerragruntReadsBothEdgeSpellings(t *testing.T) {
	root := writeTree(t, map[string]string{
		"storage": "",
		"nas": `dependency "storage" {
  config_path = "../storage"
}
`,
		"cluster": `dependency "nas" {
  config_path  = "../nas"
  mock_outputs = {}
}

dependencies {
  paths = ["../storage"]
}
`,
		"gateway": "",
	}, nil)

	got, err := ParseTerragrunt(root, "test")
	if err != nil {
		t.Fatalf("ParseTerragrunt: %v", err)
	}
	want := TerragruntGraph{
		Env:   "test",
		Units: []string{"cluster", "gateway", "nas", "storage"},
		Edges: []Edge{
			{From: "cluster", To: "nas"},
			{From: "cluster", To: "storage"},
			{From: "nas", To: "storage"},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("graph mismatch\n got: %+v\nwant: %+v", got, want)
	}
}

func TestParseTerragruntDedupesAnEdgeDeclaredTwice(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a": "",
		"b": `dependency "a" {
  config_path = "../a"
}

dependencies {
  paths = ["../a"]
}
`,
	}, nil)

	got, err := ParseTerragrunt(root, "test")
	if err != nil {
		t.Fatalf("ParseTerragrunt: %v", err)
	}
	if want := []Edge{{From: "b", To: "a"}}; !reflect.DeepEqual(got.Edges, want) {
		t.Fatalf("edges = %+v, want %+v", got.Edges, want)
	}
}

// Every case is a shape that, read naively, yields zero edges and no error.
func TestParseTerragruntRefusesShapesThatWouldDropAnEdge(t *testing.T) {
	cases := []struct {
		name  string
		units map[string]string
		extra map[string]string
		want  string
	}{
		{
			name: "paths is a local reference, not a tuple",
			units: map[string]string{"a": "", "b": `locals {
  deps = ["../a"]
}

dependencies {
  paths = local.deps
}
`},
			want: "b/terragrunt.hcl: dependencies.paths must be a literal list",
		},
		{
			name: "paths is a function call",
			units: map[string]string{"a": "", "b": `dependencies {
  paths = concat(["../a"], [])
}
`},
			want: "b/terragrunt.hcl: dependencies.paths must be a literal list",
		},
		{
			name: "paths entry is interpolated",
			units: map[string]string{"a": "", "b": `locals {
  name = "a"
}

dependencies {
  paths = ["../${local.name}"]
}
`},
			want: "b/terragrunt.hcl: dependencies.paths[0] must be a literal string",
		},
		{
			name: "config_path is a function call",
			units: map[string]string{"a": "", "b": `dependency "a" {
  config_path = find_in_parent_folders("a")
}
`},
			want: `b/terragrunt.hcl: dependency "a" config_path must be a literal string`,
		},
		{
			name: "config_path is misspelled",
			units: map[string]string{"a": "", "b": `dependency "a" {
  config_pth = "../a"
}
`},
			want: `b/terragrunt.hcl: dependency "a" has no config_path`,
		},
		{
			name: "dependencies block without paths",
			units: map[string]string{"a": "", "b": `dependencies {
  path = ["../a"]
}
`},
			want: "b/terragrunt.hcl: dependencies block has no paths",
		},
		{
			name:  "included root file declares a dependency",
			units: map[string]string{"a": "", "b": ""},
			extra: map[string]string{"terragrunt/terragrunt.hcl": rootHCL + `
dependency "a" {
  config_path = "../a"
}
`},
			want: "terragrunt/terragrunt.hcl: included by terragrunt/environments/test/a/terragrunt.hcl declares dependency,",
		},
		{
			name:  "included env file declares dependencies",
			units: map[string]string{"a": "", "b": ""},
			extra: map[string]string{"terragrunt/environments/test/env.hcl": envHCL + `
dependencies {
  paths = ["a"]
}
`},
			want: "terragrunt/environments/test/env.hcl: included by terragrunt/environments/test/a/terragrunt.hcl declares dependencies,",
		},
		{
			name: "include path is computed",
			units: map[string]string{"a": `include "extra" {
  path = "${get_terragrunt_dir()}/../common.hcl"
}
`},
			want: `a/terragrunt.hcl: include "extra" path must be a literal string or find_in_parent_folders()`,
		},
		{
			name:  "unit nested below a plain folder",
			units: map[string]string{"a": "", "extras/foo": ""},
			want:  "terragrunt/environments/test/extras/foo/terragrunt.hcl: unit is not a terragrunt.hcl directly under",
		},
		{
			name:  "unit nested inside another unit",
			units: map[string]string{"a": "", "a/sub": ""},
			want:  "terragrunt/environments/test/a/sub/terragrunt.hcl: unit is not a terragrunt.hcl directly under",
		},
		{
			name:  "unit written as terragrunt.hcl.json",
			units: map[string]string{"a": ""},
			extra: map[string]string{"terragrunt/environments/test/b/terragrunt.hcl.json": "{}"},
			want:  "terragrunt/environments/test/b/terragrunt.hcl.json: unit is not a terragrunt.hcl directly under",
		},
		{
			name: "include target exists in no parent folder",
			units: map[string]string{"a": `include "extra" {
  path = find_in_parent_folders("missing.hcl")
}
`},
			want: `a/terragrunt.hcl: include "extra": no parent folder holds the included file`,
		},
		{
			name: "edge points outside the environment's units",
			units: map[string]string{"b": `dependency "gone" {
  config_path = "../gone"
}
`},
			want: `b/terragrunt.hcl: dependency "gone" config_path "../gone" is not a unit of environment test`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := writeTree(t, tc.units, tc.extra)
			_, err := ParseTerragrunt(root, "test")
			if err == nil {
				t.Fatalf("ParseTerragrunt succeeded, want error containing %q", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q\nwant it to contain %q", err, tc.want)
			}
		})
	}
}

func TestParseTerragruntSkipsHiddenFolders(t *testing.T) {
	root := writeTree(t, map[string]string{"a": ""}, map[string]string{
		"terragrunt/environments/test/a/.terragrunt-cache/x/terragrunt.hcl": "",
	})
	g, err := ParseTerragrunt(root, "test")
	if err != nil {
		t.Fatalf("ParseTerragrunt: %v", err)
	}
	if want := []string{"a"}; !reflect.DeepEqual(g.Units, want) {
		t.Fatalf("units = %v, want %v", g.Units, want)
	}
}

func TestParseTerragruntReportsEveryFailureInOneRun(t *testing.T) {
	root := writeTree(t, map[string]string{
		"a": `dependency "x" {
  config_pth = "../b"
}
`,
		"b": `dependencies {
  paths = local.deps
}
`,
	}, nil)

	_, err := ParseTerragrunt(root, "test")
	if err == nil {
		t.Fatal("ParseTerragrunt succeeded, want two errors")
	}
	for _, want := range []string{`a/terragrunt.hcl: dependency "x" has no config_path`, "b/terragrunt.hcl: dependencies.paths must be a literal list"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q\nmissing %q", err, want)
		}
	}
}

func TestParseTerragruntRefusesAnEnvironmentWithNoUnits(t *testing.T) {
	root := writeTree(t, nil, nil)
	if _, err := ParseTerragrunt(root, "missing"); err == nil {
		t.Fatal("ParseTerragrunt succeeded for an environment with no units")
	}
}

func TestLayersOrdersDependenciesFirstAndKeepsIsolatedUnits(t *testing.T) {
	g := TerragruntGraph{
		Env:   "test",
		Units: []string{"cluster", "gateway", "nas", "storage"},
		Edges: []Edge{
			{From: "cluster", To: "nas"},
			{From: "cluster", To: "storage"},
			{From: "nas", To: "storage"},
		},
	}
	got, err := g.Layers()
	if err != nil {
		t.Fatalf("Layers: %v", err)
	}
	want := [][]string{{"gateway", "storage"}, {"nas"}, {"cluster"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("layers = %v, want %v", got, want)
	}
}

func TestLayersRefusesACycleAndNamesItsUnits(t *testing.T) {
	g := TerragruntGraph{
		Env:   "test",
		Units: []string{"a", "b", "c", "d"},
		Edges: []Edge{
			{From: "a", To: "b"},
			{From: "b", To: "c"},
			{From: "c", To: "a"},
			{From: "a", To: "d"},
		},
	}
	_, err := g.Layers()
	if err == nil {
		t.Fatal("Layers succeeded on a cycle")
	}
	if want := "dependency cycle in environment test among: a, b, c"; !strings.Contains(err.Error(), want) {
		t.Fatalf("error = %q, want %q", err, want)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no go.mod above the working directory")
		}
		dir = parent
	}
}

// The committed tree is the case that matters: both edge spellings to truenas
// and the edge-free unifi-gateway are named in ADR-034.
func TestParseTerragruntOnTheCommittedHomelabTree(t *testing.T) {
	g, err := ParseTerragrunt(repoRoot(t), "homelab")
	if err != nil {
		t.Fatalf("ParseTerragrunt: %v", err)
	}
	edges := map[Edge]bool{}
	for _, e := range g.Edges {
		edges[e] = true
	}
	for _, want := range []Edge{
		{From: "talos-cluster", To: "truenas"},
		{From: "gitops-bootstrap", To: "truenas"},
		{From: "gitops-bootstrap", To: "talos-cluster-config"},
		{From: "talos-cluster-config", To: "talos-cluster"},
	} {
		if !edges[want] {
			t.Errorf("missing edge %s -> %s", want.From, want.To)
		}
	}
	for _, e := range g.Edges {
		if e.From == "unifi-gateway" || e.To == "unifi-gateway" {
			t.Errorf("unifi-gateway has edge %s -> %s; ADR-034 records it as isolated", e.From, e.To)
		}
	}
	layers, err := g.Layers()
	if err != nil {
		t.Fatalf("Layers: %v", err)
	}
	if last := layers[len(layers)-1]; !reflect.DeepEqual(last, []string{"gitops-bootstrap"}) {
		t.Errorf("last layer = %v, want [gitops-bootstrap]", last)
	}
}

func TestParseTerragruntOnTheCommittedLocaldevTree(t *testing.T) {
	g, err := ParseTerragrunt(repoRoot(t), "localdev")
	if err != nil {
		t.Fatalf("ParseTerragrunt: %v", err)
	}
	layers, err := g.Layers()
	if err != nil {
		t.Fatalf("Layers: %v", err)
	}
	if want := [][]string{{"kind-cluster"}, {"gitops-bootstrap"}}; !reflect.DeepEqual(layers, want) {
		t.Fatalf("layers = %v, want %v", layers, want)
	}
}

var dotEdge = regexp.MustCompile(`^"([^"]+)"\s*->\s*"([^"]+)";$`)
var dotNode = regexp.MustCompile(`^"([^"]+)"\s*;$`)

// terragrunt stays the authority on what its blocks mean (ADR-034): the parsed
// graph must equal the pinned binary's own DAG.
func TestParseTerragruntMatchesTerragruntDagGraph(t *testing.T) {
	bin, err := exec.LookPath("terragrunt")
	if err != nil {
		if os.Getenv("DAG_REQUIRE_TERRAGRUNT") != "" {
			t.Fatal("DAG_REQUIRE_TERRAGRUNT is set but terragrunt is not on PATH")
		}
		t.Skip("terragrunt not on PATH")
	}
	root := repoRoot(t)
	for _, env := range []string{"homelab", "localdev"} {
		t.Run(env, func(t *testing.T) {
			cmd := exec.Command(bin, "dag", "graph")
			cmd.Dir = filepath.Join(root, "terragrunt", "environments", env)
			out, err := cmd.Output()
			if err != nil {
				t.Fatalf("terragrunt dag graph: %v", err)
			}
			want := TerragruntGraph{Env: env}
			for _, line := range strings.Split(string(out), "\n") {
				line = strings.TrimSpace(line)
				if m := dotEdge.FindStringSubmatch(line); m != nil {
					want.Edges = append(want.Edges, Edge{From: m[1], To: m[2]})
				} else if m := dotNode.FindStringSubmatch(line); m != nil {
					want.Units = append(want.Units, m[1])
				}
			}
			if len(want.Units) == 0 {
				t.Fatalf("no nodes in terragrunt dag graph output:\n%s", out)
			}
			sort.Strings(want.Units)
			sort.Slice(want.Edges, func(i, j int) bool {
				if want.Edges[i].From != want.Edges[j].From {
					return want.Edges[i].From < want.Edges[j].From
				}
				return want.Edges[i].To < want.Edges[j].To
			})

			got, err := ParseTerragrunt(root, env)
			if err != nil {
				t.Fatalf("ParseTerragrunt: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("parsed graph differs from terragrunt's\n got: %+v\nwant: %+v", got, want)
			}
		})
	}
}
