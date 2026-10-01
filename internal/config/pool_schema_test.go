package config

import (
	"path/filepath"
	"strings"
	"testing"
)

// Every control-plane member, not only the literal CP1_IP, must stay outside the LB pool.
func TestRealSchemaRejectsControlPlaneMembersInsideLBPool(t *testing.T) {
	configRoot := filepath.Join(findProjectRootForTest(t), "configuration")
	schema, err := LoadSchemaDir(filepath.Join(configRoot, "schema"))
	if err != nil {
		t.Fatal(err)
	}
	versions, err := LoadVersions(filepath.Join(configRoot, "versions.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defaults, err := LoadEnvironment(filepath.Join(configRoot, "environments", "defaults.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ setName, envFile, key string }{
		{"homelab", "homelab.yaml.example", "CP1_IP"},
		{"homelab", "homelab.yaml.example", "CP2_IP"},
		{"homelab", "homelab.yaml.example", "CP3_IP"},
		{"single-node", "single-node.yaml.example", "CP1_IP"},
		{"single-node", "single-node.yaml.example", "CP2_IP"},
	} {
		t.Run(tc.envFile+"/"+tc.key, func(t *testing.T) {
			env, err := LoadEnvironment(filepath.Join(configRoot, "environments", tc.envFile))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Eval(schema, versions, tc.setName, defaults, env); err != nil {
				t.Fatalf("unmutated example must evaluate: %v", err)
			}
			env[tc.key] = env["LB_POOL_END"]
			_, err = Eval(schema, versions, tc.setName, defaults, env)
			want := tc.key + ": infrastructure-address address " + env["LB_POOL_END"] + " must be outside"
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("got %v; want %q", err, want)
			}
		})
	}
}
