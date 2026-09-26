package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// consumedOutsideTemplates documents schema keys that are never referenced by
// a concrete `.Values.KEY.Value` expression in any configuration/templates/*.tmpl
// file, but are legitimately consumed somewhere else — Go code, another schema
// key's const expression, or the PII guard patterns. Keeping this list honest
// is enforced by TestDeclaredKeysAreReferenced: an entry that becomes
// referenced by a template must be removed (or the test fails), and every
// schema key must appear here or be referenced, or the test fails.
//
// A "DEAD:" prefix marks a key with no consumer at all found anywhere in the
// repository (not even outside templates). These are flagged for the project
// owner to decide whether to wire up or delete — they are intentionally kept
// here (not silently dropped) so the contract test stays green while making
// the gap visible in `go test -v` output and in the task report.
var consumedOutsideTemplates = map[string]string{
	"NFS_BASE_PATH": "only used inside other schema keys' const expressions " +
		`(MEDIA_MOVIES_PATH, MEDIA_TV_PATH, etc. use "{{.NFS_BASE_PATH}}/...") — ` +
		"never directly referenced by a template",
	"ARGOCD_HOSTNAME": "read by `homelab bootstrap` (cmd/homelab/commands/bootstrap.go) to print the " +
		"ArgoCD URL; its last template reference was the removed ingress-verification list",

	// The terragrunt tree reads these out of configuration/resolved*.json
	// (the `json` export), not through a helm template: terragrunt/environments/
	// */env.hcl jsondecode()s that file. They are what stops terragrunt
	// committing one operator's subnet, resolver, cluster name, hypervisor node
	// name and git remote.
	"LAN_CIDR":         "terragrunt/environments/homelab/env.hcl — locals.subnet, and the netmask of truenas_static_ip",
	"DNS_SERVER_IP":    "terragrunt/environments/{homelab,localdev}/env.hcl — locals.dns_servers",
	"CLUSTER_NAME":     "terragrunt/environments/{homelab,localdev}/env.hcl — locals.cluster_name",
	"PROXMOX_NODE":     "terragrunt/environments/homelab/env.hcl — locals.proxmox_node and every node's host_node",
	"GITOPS_REPO_URL":  "terragrunt/environments/{homelab,localdev}/env.hcl — locals.repo_url, the repository ArgoCD reconciles from",
	"LOCAL_DNS_DOMAIN": "terragrunt/environments/homelab/env.hcl — locals.local_dns_domain, the optional zone of the proxmox, k8s and truenas A records",
}

// templateRef is a single recognized expression found on one line of a
// configuration/templates/*.tmpl file.
type templateRef struct {
	file string
	line int
	kind string // "value", "chartDot", "chartIndex", "tool", "image"
	key  string
}

var (
	valuesRefRe = regexp.MustCompile(`\.Values\.([A-Z0-9_]+)\.Value`)
	// controlPlaneRefRe finds a template's use of the resolver's derived
	// control-plane list. Unlike `range .Values`, this is a NAMED field whose
	// membership is defined by the schema's control-plane key pattern, so
	// counting it as a reference is principled where the generic range is not:
	// it can only excuse the keys that pattern matches, never an arbitrary one.
	controlPlaneRefRe = regexp.MustCompile(`\.ControlPlane\b`)
	chartsDotRefRe    = regexp.MustCompile(`\.Versions\.Charts\.([A-Za-z0-9_-]+)`)
	chartsIndexRefRe  = regexp.MustCompile(`index\s+\.Versions\.Charts\s+"([A-Za-z0-9_-]+)"`)
	toolsDotRefRe     = regexp.MustCompile(`\.Versions\.Tools\.([A-Za-z0-9_-]+)`)
	imagesIndexRefRe  = regexp.MustCompile(`index\s+\.Versions\.Images\s+"([A-Za-z0-9_-]+)"`)
)

// listTemplateFiles returns the sorted list of *.tmpl files in configRoot/templates.
func listTemplateFiles(t *testing.T, configRoot string) []string {
	t.Helper()
	dir := filepath.Join(configRoot, "templates")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading templates dir: %v", err)
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tmpl") {
			continue
		}
		files = append(files, filepath.Join(dir, e.Name()))
	}
	sort.Strings(files)
	if len(files) == 0 {
		t.Fatalf("no .tmpl files found in %s", dir)
	}
	return files
}

// extractTemplateRefs scans a single template file line-by-line and returns
// every recognized .Values / .Versions expression, tagged with its line
// number for actionable test failures.
func extractTemplateRefs(t *testing.T, path string) []templateRef {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("opening template %s: %v", path, err)
	}
	defer f.Close()

	var refs []templateRef
	base := filepath.Base(path)
	scanner := bufio.NewScanner(f)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := scanner.Text()

		for _, m := range valuesRefRe.FindAllStringSubmatch(line, -1) {
			refs = append(refs, templateRef{file: base, line: lineNum, kind: "value", key: m[1]})
		}
		for _, m := range chartsDotRefRe.FindAllStringSubmatch(line, -1) {
			refs = append(refs, templateRef{file: base, line: lineNum, kind: "chartDot", key: m[1]})
		}
		for _, m := range chartsIndexRefRe.FindAllStringSubmatch(line, -1) {
			refs = append(refs, templateRef{file: base, line: lineNum, kind: "chartIndex", key: m[1]})
		}
		for _, m := range toolsDotRefRe.FindAllStringSubmatch(line, -1) {
			refs = append(refs, templateRef{file: base, line: lineNum, kind: "tool", key: m[1]})
		}
		for _, m := range imagesIndexRefRe.FindAllStringSubmatch(line, -1) {
			refs = append(refs, templateRef{file: base, line: lineNum, kind: "image", key: m[1]})
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanning template %s: %v", path, err)
	}
	return refs
}

// TestTemplatesReferenceOnlyDeclaredKeys ensures every `.Values.KEY.Value`
// expression in every template refers to a key that is actually declared in
// the schema — a template can never silently reference an undeclared key.
func TestTemplatesReferenceOnlyDeclaredKeys(t *testing.T) {
	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	schema, err := LoadSchemaDir(filepath.Join(configRoot, "schema"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}

	for _, path := range listTemplateFiles(t, configRoot) {
		for _, ref := range extractTemplateRefs(t, path) {
			if ref.kind != "value" {
				continue
			}
			if _, ok := schema.Keys[ref.key]; !ok {
				t.Errorf("%s:%d references undeclared config key %q (.Values.%s.Value)",
					ref.file, ref.line, ref.key, ref.key)
			}
		}
	}
}

// TestDeclaredKeysAreReferenced ensures every schema key is either used by a
// concrete `.Values.KEY.Value` expression in some template, or explicitly
// allowlisted in consumedOutsideTemplates with a reason. It also fails if an
// allowlisted key has since become referenced in a template — the allowlist
// must stay honest, not just grow.
//
// The dotenv.tmpl and json.tmpl templates iterate `.Values` generically
// (`range $key, $val := .Values`), which references every key without naming
// any of them concretely. That generic reference is sufficient for those two
// templates to render (see TestExampleRendersEveryTemplate) but is
// deliberately NOT treated as "referencing" a key for this test — otherwise
// every schema key would trivially satisfy this check via the generic range
// and the test would never catch a truly-unused key.
func TestDeclaredKeysAreReferenced(t *testing.T) {
	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	schema, err := LoadSchemaDir(filepath.Join(configRoot, "schema"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}

	referenced := make(map[string]bool)
	controlPlaneReferenced := false
	for _, path := range listTemplateFiles(t, configRoot) {
		for _, ref := range extractTemplateRefs(t, path) {
			if ref.kind == "value" {
				referenced[ref.key] = true
			}
		}
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading template %s: %v", path, err)
		}
		if controlPlaneRefRe.Match(src) {
			controlPlaneReferenced = true
		}
	}

	// A template that ranges .ControlPlane references every key the
	// control-plane pattern matches, CP1_IP included. Those keys do NOT go on
	// the consumedOutsideTemplates allowlist: an allowlist entry is a place a
	// key can hide, whereas this is a named field whose membership the schema
	// pattern defines, so it can only ever excuse control-plane addresses.
	cpPattern, hasCPPattern := schema.controlPlanePattern()
	if hasCPPattern && controlPlaneReferenced {
		for key := range schema.Keys {
			if cpPattern.re.MatchString(key) {
				referenced[key] = true
			}
		}
	}

	// A declared pattern with no consumer is the same dead-declaration problem
	// this test exists for, one level up: schema.Keys is not where it would
	// show, so check it explicitly.
	if hasCPPattern && !controlPlaneReferenced {
		t.Errorf("schema declares control-plane key pattern %q but no template references .ControlPlane — "+
			"the derived list has no consumer", cpPattern.pattern)
	}

	// Every allowlisted key must actually exist in the schema — otherwise the
	// allowlist is referencing a key that was renamed or removed.
	for key := range consumedOutsideTemplates {
		if _, ok := schema.Keys[key]; !ok {
			t.Errorf("consumedOutsideTemplates allowlist references key %q, which no longer exists in the schema — remove it from the allowlist", key)
		}
	}

	var undeclaredGaps []string
	for key := range schema.Keys {
		_, allowlisted := consumedOutsideTemplates[key]

		if referenced[key] && allowlisted {
			t.Errorf("key %q is allowlisted in consumedOutsideTemplates but is now referenced directly in a template — remove it from the allowlist", key)
			continue
		}

		if !referenced[key] && !allowlisted {
			undeclaredGaps = append(undeclaredGaps, key)
		}
	}

	if len(undeclaredGaps) > 0 {
		sort.Strings(undeclaredGaps)
		t.Errorf("declared schema keys are not referenced by any template and are not in consumedOutsideTemplates: %s", strings.Join(undeclaredGaps, ", "))
	}
}

// TestExampleRendersEveryTemplate exercises the full Eval -> Export pipeline
// with the two committed, PII-free environment files (homelab.yaml.example
// and localdev.yaml) against every template, asserting no error, non-empty
// output, and no leftover Go-template artifacts (`<no value>`, `{{`, `}}`).
func TestExampleRendersEveryTemplate(t *testing.T) {
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

	cases := []struct {
		setName string
		envFile string
	}{
		{"homelab", "homelab.yaml.example"},
		{"localdev", "localdev.yaml"},
		// A committed topology that is NOT this cluster's. Both files above
		// declare three control-plane addresses, so before this row every
		// render in CI had a three-node shape and a fork running one or five
		// was unexercised — the gap behind ADR-035's merge condition.
		{"single-node", "single-node.yaml.example"},
	}

	templates := listTemplateFiles(t, configRoot)

	for _, c := range cases {
		t.Run(c.setName, func(t *testing.T) {
			env, err := LoadEnvironment(filepath.Join(configRoot, "environments", c.envFile))
			if err != nil {
				t.Fatalf("loading %s: %v", c.envFile, err)
			}

			rc, err := Eval(schema, versions, c.setName, defaults, env)
			if err != nil {
				t.Fatalf("eval for %s: %v", c.envFile, err)
			}

			for _, tmplPath := range templates {
				tmplName := filepath.Base(tmplPath)
				t.Run(tmplName, func(t *testing.T) {
					output, err := Export(rc, tmplPath)
					if err != nil {
						t.Fatalf("export %s with %s: %v", tmplName, c.envFile, err)
					}
					if len(strings.TrimSpace(output)) == 0 {
						t.Fatalf("export %s with %s produced empty output", tmplName, c.envFile)
					}
					if strings.Contains(output, "<no value>") {
						t.Errorf("export %s with %s left a %q artifact in the output", tmplName, c.envFile, "<no value>")
					}
					if strings.Contains(output, "{{") || strings.Contains(output, "}}") {
						t.Errorf("export %s with %s left unrendered template delimiters (\"{{\" / \"}}\") in the output", tmplName, c.envFile)
					}
				})
			}
		})
	}
}

// TestVersionsReferencedExist ensures every chart/tool/image version
// referenced by a template actually exists in versions.yaml, naming the
// exact template and line number on failure.
func TestVersionsReferencedExist(t *testing.T) {
	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	versions, err := LoadVersions(filepath.Join(configRoot, "versions.yaml"))
	if err != nil {
		t.Fatalf("loading versions: %v", err)
	}

	for _, path := range listTemplateFiles(t, configRoot) {
		for _, ref := range extractTemplateRefs(t, path) {
			switch ref.kind {
			case "chartDot", "chartIndex":
				if _, ok := versions.Charts[ref.key]; !ok {
					t.Errorf("%s:%d references chart %q, which does not exist in configuration/versions.yaml charts",
						ref.file, ref.line, ref.key)
				}
			case "tool":
				if _, ok := versions.Tools[ref.key]; !ok {
					t.Errorf("%s:%d references tool %q, which does not exist in configuration/versions.yaml tools",
						ref.file, ref.line, ref.key)
				}
			case "image":
				if _, ok := versions.Images[ref.key]; !ok {
					t.Errorf("%s:%d references image %q, which does not exist in configuration/versions.yaml images",
						ref.file, ref.line, ref.key)
				}
			}
		}
	}
}

// TestControlPlaneKeyPatternMatchesContract asserts that the schema's
// control-plane key pattern is character-identical to
// contracts/cluster/topology.v1.yaml's controlPlane.countKeyPattern.
//
// This is the whole point of ADR-035 applied to itself. The `^CP([0-9]+)_IP$`
// rule has to be stated in two files — the contract is normative and the schema
// is what the resolver loads — and two statements of one rule is exactly the
// duplication the contract exists to end. So they are held equal by a test
// rather than by anyone remembering. The contract is the source; if they
// diverge, the schema is what changes.
func TestControlPlaneKeyPatternMatchesContract(t *testing.T) {
	projectRoot := findProjectRootForTest(t)

	schema, err := LoadSchemaDir(filepath.Join(projectRoot, "configuration", "schema"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}

	cp, ok := schema.controlPlanePattern()
	if !ok {
		t.Fatalf("no schema key pattern declares role %q; the control-plane address list cannot be derived", RoleControlPlaneAddress)
	}

	data, err := os.ReadFile(filepath.Join(projectRoot, "contracts", "cluster", "topology.v1.yaml"))
	if err != nil {
		t.Fatalf("reading topology contract: %v", err)
	}
	var contract struct {
		ControlPlane struct {
			CountKeyPattern        string `yaml:"countKeyPattern"`
			CountSourceSchemaReady bool   `yaml:"countSourceSchemaReady"`
			PermittedCounts        []int  `yaml:"permittedCounts"`
		} `yaml:"controlPlane"`
	}
	if err := yaml.Unmarshal(data, &contract); err != nil {
		t.Fatalf("parsing topology contract: %v", err)
	}

	if cp.pattern != contract.ControlPlane.CountKeyPattern {
		t.Errorf("schema control-plane key pattern %q != topology.v1.yaml controlPlane.countKeyPattern %q — "+
			"one rule, two statements; make the schema match the contract",
			cp.pattern, contract.ControlPlane.CountKeyPattern)
	}

	// The Go-side half of the flag gate. scripts/topology-contract_test.ts
	// checks the flag against the schema's required keys; this checks it
	// against the thing that actually decides whether a derivation is possible.
	if !contract.ControlPlane.CountSourceSchemaReady {
		t.Errorf("the schema declares the control-plane pattern %q, so countSourceSchemaReady must be true", cp.pattern)
	}
}

// TestSyntheticTopologiesRenderEveryTemplate renders every template against a
// synthetic ConfigSet for each count in the contract's permittedCounts.
//
// The committed single-node example covers the one shape with special
// behaviour. This covers the rest: without it, 5 and 7 are topologies the
// contract permits and no test has ever rendered, and the fixed shape would
// have moved out of the schema and into the test matrix.
func TestSyntheticTopologiesRenderEveryTemplate(t *testing.T) {
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
	base, err := LoadEnvironment(filepath.Join(configRoot, "environments", "single-node.yaml.example"))
	if err != nil {
		t.Fatalf("loading single-node example: %v", err)
	}

	templates := listTemplateFiles(t, configRoot)

	for _, count := range []int{1, 3, 5, 7} {
		t.Run(fmt.Sprintf("count-%d", count), func(t *testing.T) {
			env := make(map[string]string, len(base)+count)
			for k, v := range base {
				env[k] = v
			}
			for i := 1; i <= count; i++ {
				// RFC 5737 TEST-NET-1, matching the base fixture.
				env[fmt.Sprintf("CP%d_IP", i)] = fmt.Sprintf("192.0.2.%d", 10+i)
			}

			rc, err := Eval(schema, versions, "synthetic", defaults, env)
			if err != nil {
				t.Fatalf("eval for %d control planes: %v", count, err)
			}

			if got := len(rc.ControlPlane); got != count {
				t.Fatalf("derived %d control-plane members, want %d", got, count)
			}
			for i, m := range rc.ControlPlane {
				if m.Ordinal != i+1 {
					t.Errorf("member %d has ordinal %d, want %d — the list must be ascending by ordinal", i, m.Ordinal, i+1)
				}
			}

			for _, tmplPath := range templates {
				tmplName := filepath.Base(tmplPath)
				output, err := Export(rc, tmplPath)
				if err != nil {
					t.Fatalf("export %s at %d control planes: %v", tmplName, count, err)
				}
				if strings.Contains(output, "<no value>") {
					t.Errorf("export %s at %d control planes left a %q artifact", tmplName, count, "<no value>")
				}
			}

			// The rendered inventory must name exactly the members the
			// ConfigSet declared — a topology that renders cleanly but omits a
			// node is the silent version of this bug.
			inventory, err := Export(rc, filepath.Join(configRoot, "templates", "ansible-inventory.tmpl"))
			if err != nil {
				t.Fatalf("export ansible-inventory.tmpl: %v", err)
			}
			for i := 1; i <= count; i++ {
				if !strings.Contains(inventory, fmt.Sprintf("cp-%d:", i)) {
					t.Errorf("ansible inventory at %d control planes is missing host cp-%d", count, i)
				}
			}
			if strings.Contains(inventory, fmt.Sprintf("cp-%d:", count+1)) {
				t.Errorf("ansible inventory at %d control planes names cp-%d, which the ConfigSet does not declare", count, count+1)
			}
		})
	}
}

// TestNonContiguousOrdinalsAreNotMiscounted pins ADR-035's statement that
// ordinals need not be contiguous: CP1/CP2/CP5 is three members, not five.
// Counting the highest ordinal instead of the matching keys would overstate the
// member count, and this guard is destructive-path-adjacent — too high means it
// refuses on a healthy cluster.
func TestNonContiguousOrdinalsAreNotMiscounted(t *testing.T) {
	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	schema, err := LoadSchemaDir(filepath.Join(configRoot, "schema"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}

	members, err := DeriveControlPlane(schema, map[string]string{
		"CP10_IP":    "192.0.2.20",
		"CP2_IP":     "192.0.2.12",
		"CP1_IP":     "192.0.2.11",
		"CP_VIP":     "192.0.2.10",
		"WORKER1_IP": "192.0.2.21",
	})
	if err != nil {
		t.Fatalf("deriving control plane: %v", err)
	}

	var got []int
	for _, m := range members {
		got = append(got, m.Ordinal)
	}
	// Ascending by ORDINAL, not by key name: sorted as strings CP10_IP comes
	// before CP2_IP, and the inventory would render cp-10 second.
	want := []int{1, 2, 10}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("derived ordinals %v, want %v", got, want)
	}
}
