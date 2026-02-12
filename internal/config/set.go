package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// LoadEnvironment loads a flat key-value YAML file.
func LoadEnvironment(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading environment %s: %w", path, err)
	}

	var raw map[string]interface{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parsing environment %s: %w", path, err)
	}

	env := make(map[string]string, len(raw))
	for k, v := range raw {
		env[k] = fmt.Sprintf("%v", v)
	}

	return env, nil
}

// ResolveHierarchy merges environment maps in order. Later maps override earlier ones.
func ResolveHierarchy(layers ...map[string]string) map[string]string {
	merged := make(map[string]string)
	for _, layer := range layers {
		for k, v := range layer {
			merged[k] = v
		}
	}
	return merged
}

// LoadVersions loads the centralized versions.yaml file.
func LoadVersions(path string) (*Versions, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading versions %s: %w", path, err)
	}

	var v Versions
	if err := yaml.Unmarshal(data, &v); err != nil {
		return nil, fmt.Errorf("parsing versions %s: %w", path, err)
	}

	return &v, nil
}
