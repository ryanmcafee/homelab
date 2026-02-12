package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// LoadSchemaFile loads and parses a single .schema.yaml file.
func LoadSchemaFile(path string) (*SchemaFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading schema %s: %w", path, err)
	}

	var sf SchemaFile
	if err := yaml.Unmarshal(data, &sf); err != nil {
		return nil, fmt.Errorf("parsing schema %s: %w", path, err)
	}

	if sf.Keys == nil || len(sf.Keys) == 0 {
		return nil, fmt.Errorf("schema %s has no 'keys' field or keys are empty", path)
	}

	return &sf, nil
}

// LoadSchemaDir loads all .schema.yaml files from a directory and merges them into a single Schema.
func LoadSchemaDir(dir string) (*Schema, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("reading schema directory %s: %w", dir, err)
	}

	schema := &Schema{Keys: make(map[string]SchemaKey)}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".schema.yaml") {
			continue
		}

		sf, err := LoadSchemaFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			// Skip invalid files in directory mode (e.g. test fixtures)
			continue
		}

		for name, key := range sf.Keys {
			if _, exists := schema.Keys[name]; exists {
				return nil, fmt.Errorf("duplicate key %q found in %s", name, entry.Name())
			}
			schema.Keys[name] = key
		}
	}

	if len(schema.Keys) == 0 {
		return nil, fmt.Errorf("no valid schema keys found in %s", dir)
	}

	return schema, nil
}
