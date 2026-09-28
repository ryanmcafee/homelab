package prereq

import (
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/config"
)

func TestExamplePlacement(t *testing.T) {
	tests := []struct {
		name string
		key  config.SchemaKey
		want string
	}{
		{
			name: "no default and not computed: a fork has to supply it",
			key:  config.SchemaKey{Required: true},
			want: ExampleRequired,
		},
		{
			name: "schema default: present or absent both resolve",
			key:  config.SchemaKey{Required: true, Default: "none"},
			want: ExampleOptional,
		},
		{
			name: "computed: a value in the example is ignored at render",
			key:  config.SchemaKey{Required: true, Const: "argocd.{{.DOMAIN}}"},
			want: ExampleForbidden,
		},
		{
			// A hidden key with a default must not be advertised as tunable;
			// const is checked first so the two cannot disagree.
			name: "hidden outranks its default",
			key:  config.SchemaKey{Required: true, Hidden: true, Default: "x"},
			want: ExampleForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := examplePlacement(tc.key); got != tc.want {
				t.Errorf("examplePlacement() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRequiredKeysForTierEmitsOnlyRequiredKeysSorted(t *testing.T) {
	schema, err := config.NewSchema(map[string]config.SchemaKey{
		"ZULU":     {Required: true, Description: "last by name, first by luck"},
		"ALPHA":    {Required: true, Description: "first"},
		"OPTIONAL": {Required: false, Description: "not part of the union"},
	}, nil)
	if err != nil {
		t.Fatalf("NewSchema: %v", err)
	}

	keys, err := requiredKeysForTier(schema, Homelab)
	if err != nil {
		t.Fatalf("requiredKeysForTier: %v", err)
	}

	var names []string
	for _, key := range keys {
		names = append(names, key.Name)
		if !key.Required {
			t.Errorf("key %q is in the document with required=false", key.Name)
		}
		if key.Source != KeySourceSchema {
			t.Errorf("key %q has source %q, want %q", key.Name, key.Source, KeySourceSchema)
		}
	}
	if got := strings.Join(names, ","); got != "ALPHA,ZULU" {
		t.Errorf("keys = %q, want %q (sorted, required only)", got, "ALPHA,ZULU")
	}
}

// A key pattern cannot carry a requirement -- validateKeyPattern refuses
// required: true on a family, because a regex has no name to demand. So CP2_IP
// upward never reach the document and a fork's cluster size is its own business.
func TestRequiredKeysForTierIgnoresKeyFamilies(t *testing.T) {
	schema, err := config.NewSchema(
		map[string]config.SchemaKey{"CP1_IP": {Required: true, Description: "control plane node 1"}},
		map[string]config.SchemaKeyPattern{
			`^CP([0-9]+)_IP$`: {Role: config.RoleControlPlaneAddress},
		})
	if err != nil {
		t.Fatalf("NewSchema: %v", err)
	}

	keys, err := requiredKeysForTier(schema, Homelab)
	if err != nil {
		t.Fatalf("requiredKeysForTier: %v", err)
	}
	if len(keys) != 1 || keys[0].Name != "CP1_IP" {
		t.Errorf("keys = %+v, want only the literal CP1_IP", keys)
	}
}

// Declaring a bootstrap key the schema already requires is the forked key list
// this document exists to prevent, so it fails the build instead of winning.
func TestRequiredKeysForTierRejectsABootstrapKeyTheSchemaAlreadyRequires(t *testing.T) {
	schema, err := config.NewSchema(
		map[string]config.SchemaKey{"PROXMOX_IP": {Required: true, Description: "hypervisor"}}, nil)
	if err != nil {
		t.Fatalf("NewSchema: %v", err)
	}

	old := bootstrapRequiredKeys
	bootstrapRequiredKeys = map[Tier][]RequiredKey{
		Homelab: {{Name: "PROXMOX_IP", Required: true, Description: "hypervisor", Example: ExampleRequired}},
	}
	t.Cleanup(func() { bootstrapRequiredKeys = old })

	_, err = requiredKeysForTier(schema, Homelab)
	if err == nil {
		t.Fatal("expected a duplicate-declaration error, got none")
	}
	for _, want := range []string{"PROXMOX_IP", "one source"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err.Error(), want)
		}
	}
}

func TestRequiredKeysForTierMarksBootstrapOnlyKeys(t *testing.T) {
	schema, err := config.NewSchema(
		map[string]config.SchemaKey{"DOMAIN": {Required: true, Description: "base domain"}}, nil)
	if err != nil {
		t.Fatalf("NewSchema: %v", err)
	}

	old := bootstrapRequiredKeys
	bootstrapRequiredKeys = map[Tier][]RequiredKey{
		Homelab: {{Name: "AAA_PHASE_ONLY", Required: true, Description: "needed by a phase", Example: ExampleRequired}},
	}
	t.Cleanup(func() { bootstrapRequiredKeys = old })

	keys, err := requiredKeysForTier(schema, Homelab)
	if err != nil {
		t.Fatalf("requiredKeysForTier: %v", err)
	}
	if len(keys) != 2 {
		t.Fatalf("keys = %+v, want the schema key and the bootstrap key", keys)
	}
	// Sorted, so the bootstrap key leads; source is stamped here, not trusted
	// from the table.
	if keys[0].Name != "AAA_PHASE_ONLY" || keys[0].Source != KeySourceBootstrap {
		t.Errorf("keys[0] = %+v, want AAA_PHASE_ONLY with source %q", keys[0], KeySourceBootstrap)
	}
	if keys[1].Source != KeySourceSchema {
		t.Errorf("keys[1] = %+v, want source %q", keys[1], KeySourceSchema)
	}

	// The localdev tier declared none, so it must not inherit homelab's.
	localdevKeys, err := requiredKeysForTier(schema, Localdev)
	if err != nil {
		t.Fatalf("requiredKeysForTier(localdev): %v", err)
	}
	if len(localdevKeys) != 1 {
		t.Errorf("localdev keys = %+v, want only the schema key", localdevKeys)
	}
}

// The bootstrap table must stay a statement about keys the schema does NOT
// require. This is the guard on the live table, not on a fixture.
func TestBootstrapRequiredKeysAreWellFormed(t *testing.T) {
	for tier, keys := range bootstrapRequiredKeys {
		if tier.rank() < 0 {
			t.Errorf("bootstrapRequiredKeys declares unknown tier %q", tier)
		}
		for _, key := range keys {
			if key.Name == "" {
				t.Errorf("tier %q has a bootstrap key with no name", tier)
			}
			if key.Description == "" {
				t.Errorf("tier %q: bootstrap key %q has no description", tier, key.Name)
			}
			switch key.Example {
			case ExampleRequired, ExampleOptional, ExampleForbidden:
			default:
				t.Errorf("tier %q: bootstrap key %q has unknown example placement %q", tier, key.Name, key.Example)
			}
		}
	}
}

// BuildRequiredKeys reads the real configuration/schema. It must cover every
// tier bootstrap can run: a tier missing from the document is a tier the
// fork-ability gate never checks.
func TestBuildRequiredKeysCoversEveryTier(t *testing.T) {
	doc, err := BuildRequiredKeys(Options{ConfigRoot: "../../configuration"})
	if err != nil {
		t.Fatalf("BuildRequiredKeys: %v", err)
	}
	if doc.Version != RequiredKeysVersion {
		t.Errorf("version = %d, want %d", doc.Version, RequiredKeysVersion)
	}

	seen := map[Tier]bool{}
	for _, tier := range doc.Tiers {
		if seen[tier.Tier] {
			t.Errorf("tier %q appears twice", tier.Tier)
		}
		seen[tier.Tier] = true
		if len(tier.OperatorSuppliedKeys()) == 0 {
			t.Errorf("tier %q lists no keys a fork must supply; DOMAIN alone should qualify", tier.Tier)
		}
	}
	for _, tier := range AllTiers() {
		if !seen[tier] {
			t.Errorf("document omits tier %q", tier)
		}
	}
}
