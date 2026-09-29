package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/config"
)

// ConfigSchemaPath is the repo-relative directory the configuration contract is
// declared in: the `*.schema.yaml` files whose `required:`, `pattern:`, `enum:`
// and `const:` fields are every value-level check the resolver runs.
const ConfigSchemaPath = "configuration/schema"

// SchemaFields is the level-0 gate on schema field NAMES (ADR-053).
//
// It exists because the failure it catches is silent and subtractive. The
// resolver decodes a schema file with a lenient yaml.Unmarshal, so a misspelled
// `requred:` is dropped without an error and the key is simply not required --
// `homelab config validate` then exits 0 against a ConfigSet that omits it. The
// same mechanism turns a typo'd `patern:` into a key with no validation regex.
// Nothing trips; a check just stops existing.
//
// Strictness lives here rather than in the resolver because this is the only
// place where binary/schema skew cannot exist: the gate reads schema files from
// the same commit as the binary reading them. A fork running an older homelab
// binary against newer schema files still resolves, ignoring the field it does
// not know. Both halves are asserted together by
// TestSchemaFieldsRejectsWhatTheResolverAccepts.
func SchemaFields(repoRoot string) []Check {
	start := time.Now()
	dir := filepath.Join(repoRoot, filepath.FromSlash(ConfigSchemaPath))

	entries, err := os.ReadDir(dir)
	if err != nil {
		return []Check{FailCheck("config/schema-fields", start,
			"reading "+ConfigSchemaPath, err.Error())}
	}

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".schema.yaml") {
			names = append(names, e.Name())
		}
	}
	// Sorted so a repository with two bad files reports the same one first
	// every run; directory order would make the message flap between machines.
	sort.Strings(names)

	// A directory that yields no schema file is not a passing directory, it is
	// a scan that inspected nothing. Without this floor the check reports
	// "0 files, every field name known" after a path change and its green
	// means nothing.
	if len(names) == 0 {
		return []Check{FailCheck("config/schema-fields", start,
			"the configuration contract is declared in "+ConfigSchemaPath+"/*.schema.yaml. Finding none means this check inspected nothing, and a green from a scan that read no files proves nothing.",
			ConfigSchemaPath+": 0 schema files")}
	}

	var findings []string
	for _, name := range names {
		rel := ConfigSchemaPath + "/" + name
		fileFindings, err := config.ParseSchemaFileStrict(filepath.Join(dir, name))
		if err != nil {
			findings = append(findings, rel+": "+err.Error())
			continue
		}
		for _, f := range fileFindings {
			findings = append(findings, rel+": "+f)
		}
	}

	if len(findings) > 0 {
		return []Check{FailCheck("config/schema-fields", start,
			"a schema key may only name fields this build declares -- description, required, pattern, default, const, enum, hidden, label, plus role on a keyPatterns entry. An unrecognized name is almost always a typo, and a typo here is subtractive: `requred:` does not fail, it yields a key that is not required, and `patern:` yields a key with no validation regex. Fix the spelling; if you are adding a genuinely new field, declare it on SchemaKey in internal/config/types.go in the same change.",
			findings...)}
	}

	return []Check{PassCheck("config/schema-fields", start,
		fmt.Sprintf("%d schema files, every field name declared", len(names)))}
}
