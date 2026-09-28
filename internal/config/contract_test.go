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

	// The terragrunt tree reads these four out of configuration/resolved*.json
	// (the `json` export), not through a helm template: terragrunt/environments/
	// */env.hcl jsondecode()s that file. They are what stops terragrunt
	// committing one operator's subnet, resolver, cluster name and hypervisor
	// node name.
	//
	// GITOPS_REPO_URL is read there too, but it is NOT allowlisted: the helm
	// templates consume it through the resolver's derived .GitOps field, which
	// this test counts as a reference the same way it counts .ControlPlane.
	"LAN_CIDR":      "terragrunt/environments/homelab/env.hcl — locals.subnet, and the netmask of truenas_static_ip",
	"DNS_SERVER_IP": "terragrunt/environments/{homelab,localdev}/env.hcl — locals.dns_servers",
	"CLUSTER_NAME":  "terragrunt/environments/{homelab,localdev}/env.hcl — locals.cluster_name",
	"PROXMOX_NODE":  "terragrunt/environments/homelab/env.hcl — locals.proxmox_node and every node's host_node",
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
	// controlPlaneRefRe and workersRefRe find a template's use of the resolver's
	// derived address lists. Unlike `range .Values`, these are NAMED fields
	// whose membership is defined by a schema key pattern, so counting one as a
	// reference is principled where the generic range is not: it can only excuse
	// the keys its own pattern matches, never an arbitrary one.
	controlPlaneRefRe = regexp.MustCompile(`\.ControlPlane\b`)
	workersRefRe      = regexp.MustCompile(`\.Workers\b`)
	// gitOpsRefRe finds a template's use of the resolver's derived GitOps
	// remote. Same principle as .ControlPlane: a named field with one source
	// key, so counting it as a reference can only ever excuse GITOPS_REPO_URL.
	gitOpsRefRe      = regexp.MustCompile(`\.GitOps\.`)
	chartsDotRefRe   = regexp.MustCompile(`\.Versions\.Charts\.([A-Za-z0-9_-]+)`)
	chartsIndexRefRe = regexp.MustCompile(`index\s+\.Versions\.Charts\s+"([A-Za-z0-9_-]+)"`)
	toolsDotRefRe    = regexp.MustCompile(`\.Versions\.Tools\.([A-Za-z0-9_-]+)`)
	imagesIndexRefRe = regexp.MustCompile(`index\s+\.Versions\.Images\s+"([A-Za-z0-9_-]+)"`)
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

	// Each derived address list is a named template field, checked by the same
	// rule: the field's regexp, the schema role whose pattern defines its
	// membership, and the field name to report.
	families := []struct {
		field      string
		role       string
		refRe      *regexp.Regexp
		referenced bool
	}{
		{field: ".ControlPlane", role: RoleControlPlaneAddress, refRe: controlPlaneRefRe},
		{field: ".Workers", role: RoleWorkerAddress, refRe: workersRefRe},
	}

	referenced := make(map[string]bool)
	gitOpsReferenced := false
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
		for i := range families {
			if families[i].refRe.Match(src) {
				families[i].referenced = true
			}
		}
		if gitOpsRefRe.Match(src) {
			gitOpsReferenced = true
		}
	}

	// A template reading .GitOps reads GITOPS_REPO_URL — the resolver parses
	// that one key into the field. Marking the key referenced here is what
	// keeps it off the allowlist while it has a real template consumer.
	if _, declared := schema.Keys[GitOpsRepoKey]; declared {
		if gitOpsReferenced {
			referenced[GitOpsRepoKey] = true
		} else {
			t.Errorf("schema declares %s but no template references .GitOps — a fork's ArgoCD would "+
				"reconcile whatever repository the templates name instead", GitOpsRepoKey)
		}
	}

	// A template that ranges .ControlPlane references every key the
	// control-plane pattern matches, CP1_IP included; likewise .Workers and
	// WORKER1_IP. Those keys do NOT go on the consumedOutsideTemplates
	// allowlist: an allowlist entry is a place a key can hide, whereas this is a
	// named field whose membership the schema pattern defines, so it can only
	// ever excuse addresses of that one role.
	//
	// A declared pattern with no consumer is the same dead-declaration problem
	// this test exists for, one level up: schema.Keys is not where it would
	// show, so check it explicitly.
	for _, fam := range families {
		pattern, declared := schema.patternForRole(fam.role)
		if !declared {
			continue
		}
		if !fam.referenced {
			t.Errorf("schema declares key pattern %q with role %q but no template references %s — "+
				"the derived list has no consumer", pattern.pattern, fam.role, fam.field)
			continue
		}
		for key := range schema.Keys {
			if pattern.re.MatchString(key) {
				referenced[key] = true
			}
		}
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

	// The control-plane counts are the contract's permittedCounts. The worker
	// counts are free — nothing constrains them to be odd, because a worker
	// holds no etcd member — so they are varied independently of the control
	// plane. A matrix that moved both together would pass just as happily on a
	// renderer that had hard-coded "workers = control planes".
	cases := []struct{ cps, workers int }{
		{1, 1}, {1, 2}, {3, 3}, {3, 6}, {5, 1}, {7, 4},
	}

	for _, tc := range cases {
		t.Run(fmt.Sprintf("cp-%d-worker-%d", tc.cps, tc.workers), func(t *testing.T) {
			env := make(map[string]string, len(base)+tc.cps+tc.workers)
			for k, v := range base {
				env[k] = v
			}
			// RFC 5737 TEST-NET-1, matching the base fixture. The two families
			// sit in disjoint host ranges so a renderer that crossed them shows
			// up as a wrong address rather than a coincidence.
			for i := 1; i <= tc.cps; i++ {
				env[fmt.Sprintf("CP%d_IP", i)] = fmt.Sprintf("192.0.2.%d", 10+i)
			}
			for i := 1; i <= tc.workers; i++ {
				env[fmt.Sprintf("WORKER%d_IP", i)] = fmt.Sprintf("192.0.2.%d", 30+i)
			}

			rc, err := Eval(schema, versions, "synthetic", defaults, env)
			if err != nil {
				t.Fatalf("eval for %d control planes and %d workers: %v", tc.cps, tc.workers, err)
			}

			for _, fam := range []struct {
				label   string
				members []NodeMember
				want    int
			}{
				{"control-plane", rc.ControlPlane, tc.cps},
				{"worker", rc.Workers, tc.workers},
			} {
				if got := len(fam.members); got != fam.want {
					t.Fatalf("derived %d %s members, want %d", got, fam.label, fam.want)
				}
				for i, m := range fam.members {
					if m.Ordinal != i+1 {
						t.Errorf("%s member %d has ordinal %d, want %d — the list must be ascending by ordinal",
							fam.label, i, m.Ordinal, i+1)
					}
				}
			}

			for _, tmplPath := range templates {
				tmplName := filepath.Base(tmplPath)
				output, err := Export(rc, tmplPath)
				if err != nil {
					t.Fatalf("export %s at %d/%d: %v", tmplName, tc.cps, tc.workers, err)
				}
				if strings.Contains(output, "<no value>") {
					t.Errorf("export %s at %d/%d left a %q artifact", tmplName, tc.cps, tc.workers, "<no value>")
				}
			}

			// The rendered inventory must name exactly the nodes the ConfigSet
			// declared — a topology that renders cleanly but omits a node is the
			// silent version of this bug, and naming one it never declared is
			// the loud one.
			inventory, err := Export(rc, filepath.Join(configRoot, "templates", "ansible-inventory.tmpl"))
			if err != nil {
				t.Fatalf("export ansible-inventory.tmpl: %v", err)
			}
			for _, fam := range []struct {
				host  string
				count int
			}{
				{"cp", tc.cps},
				{"worker", tc.workers},
			} {
				for i := 1; i <= fam.count; i++ {
					if !strings.Contains(inventory, fmt.Sprintf("%s-%d:", fam.host, i)) {
						t.Errorf("ansible inventory at %d/%d is missing host %s-%d", tc.cps, tc.workers, fam.host, i)
					}
				}
				if strings.Contains(inventory, fmt.Sprintf("%s-%d:", fam.host, fam.count+1)) {
					t.Errorf("ansible inventory at %d/%d names %s-%d, which the ConfigSet does not declare",
						tc.cps, tc.workers, fam.host, fam.count+1)
				}
			}
		})
	}
}

// TestTerragruntNodeMapsDeriveFromKeyPatterns pins the key-name patterns
// terragrunt/environments/homelab/env.hcl uses to build control_plane_nodes and
// worker_nodes to the schema's own keyPatterns entries.
//
// Terragrunt cannot read ResolvedConfig.ControlPlane: env.hcl jsondecode()s the
// flat `values` map out of configuration/resolved.json, so it is the one
// consumer that must re-apply the key-name rule rather than read the derived
// list. That makes it the one place the rule can drift silently — a schema
// pattern that gained an ordinal form env.hcl does not match would provision a
// cluster missing a node, and terraform would report success. Nothing else in
// the repository compares the two strings.
func TestTerragruntNodeMapsDeriveFromKeyPatterns(t *testing.T) {
	projectRoot := findProjectRootForTest(t)

	schema, err := LoadSchemaDir(filepath.Join(projectRoot, "configuration", "schema"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}

	envHCLPath := filepath.Join(projectRoot, "terragrunt", "environments", "homelab", "env.hcl")
	src, err := os.ReadFile(envHCLPath)
	if err != nil {
		t.Fatalf("reading %s: %v", envHCLPath, err)
	}

	for _, fam := range []struct{ local, role string }{
		{"cp_key_pattern", RoleControlPlaneAddress},
		{"worker_key_pattern", RoleWorkerAddress},
	} {
		pattern, ok := schema.patternForRole(fam.role)
		if !ok {
			t.Errorf("schema declares no key pattern with role %q", fam.role)
			continue
		}
		// Matched by regexp rather than by literal substring so `terraform fmt`
		// realigning the `=` cannot turn a real drift guard into a passing one.
		assign := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(fam.local) + `\s*=\s*"(.*)"\s*$`)
		m := assign.FindSubmatch(src)
		if m == nil {
			t.Errorf("env.hcl declares no local %q; the %q node map must state the key pattern it derives from",
				fam.local, fam.role)
			continue
		}
		// The HCL literal escapes nothing the schema does not, so a byte
		// comparison of the quoted string is the whole check.
		if got := string(m[1]); got != pattern.pattern {
			t.Errorf("env.hcl local %s is %q but the schema's %q pattern is %q — "+
				"terragrunt would derive a different node set than the resolver",
				fam.local, got, fam.role, pattern.pattern)
		}
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
