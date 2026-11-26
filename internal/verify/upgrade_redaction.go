package verify

import (
	"fmt"
	"sort"
)

const upgradeContentOmitted = "manifest content and tool diagnostics omitted for Secret safety; reproduce locally with synthetic values"

// redactUpgradeSecrets masks parsed values before any report or diff sees them.
// Originals are held only for the in-memory comparison of key changes.
func redactUpgradeSecrets(value any, secretItem bool, path string, originals map[string]string) error {
	switch v := value.(type) {
	case map[string]any:
		kind, _ := v["kind"].(string)
		secret := kind == "Secret" || secretItem
		if secret {
			for _, field := range []string{"data", "stringData"} {
				if raw, exists := v[field]; exists {
					if raw == nil {
						v[field] = map[string]any{}
						continue
					}
					m, ok := raw.(map[string]any)
					if !ok {
						return fmt.Errorf("unsupported Secret field; %s", upgradeContentOmitted)
					}
					for key, rawValue := range m {
						value, ok := rawValue.(string)
						if !ok {
							return fmt.Errorf("unsupported Secret value; %s", upgradeContentOmitted)
						}
						originals[path+field+"/"+key] = value
						m[key] = "<redacted>"
					}
				}
			}
		}
		if metadata, ok := v["metadata"].(map[string]any); ok {
			if annotations, ok := metadata["annotations"].(map[string]any); ok {
				delete(annotations, "kubectl.kubernetes.io/last-applied-configuration")
			}
		}
		for key, child := range v {
			if secret && (key == "data" || key == "stringData") {
				continue
			}
			if err := redactUpgradeSecrets(child, key == "items" && kind == "SecretList", path+key+"/", originals); err != nil {
				return err
			}
		}
	case []any:
		for i, child := range v {
			if err := redactUpgradeSecrets(child, secretItem, fmt.Sprintf("%s%d/", path, i), originals); err != nil {
				return err
			}
		}
	case map[any]any:
		return fmt.Errorf("unsupported manifest mapping; %s", upgradeContentOmitted)
	}
	return nil
}

// secretKeyDiff publishes key names and status, never values or fingerprints.
func secretKeyDiff(base, head map[string]string) ([]string, int, int) {
	keys := make(map[string]bool, len(base)+len(head))
	for key := range base {
		keys[key] = true
	}
	for key := range head {
		keys[key] = true
	}
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	var lines []string
	added, deleted := 0, 0
	for _, key := range ordered {
		b, bok := base[key]
		h, hok := head[key]
		switch {
		case !bok:
			lines = append(lines, "Secret key added: "+key)
			added++
		case !hok:
			lines = append(lines, "Secret key removed: "+key)
			deleted++
		case b != h:
			lines = append(lines, "Secret key changed: "+key)
			added++
			deleted++
		}
	}
	return lines, added, deleted
}
