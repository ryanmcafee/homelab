package commands

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/utils"
)

func TestInstallTools(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable fixtures use a POSIX shell")
	}
	for _, tc := range []struct {
		name   string
		script string
		want   string
		code   int
	}{
		{
			name:   "installer stderr identifies failing tool",
			script: "#!/bin/sh\nprintf '%s\\n' 'pipx:ansible-core: pipx is required but was not found' >&2\nexit 42\n",
			want:   "pipx:ansible-core: pipx is required but was not found",
			code:   42,
		},
		{
			name:   "success creates plugin cache",
			script: "#!/bin/sh\n[ \"$1\" = install ] && [ \"$2\" = -y ]\n",
		},
		{
			name: "missing executable retains launch error",
			want: "executable file not found",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			oldDryRun := utils.DryRun
			utils.DryRun = false
			t.Cleanup(func() { utils.DryRun = oldDryRun })
			dir := t.TempDir()
			t.Chdir(dir)
			t.Setenv("PATH", dir)
			if tc.script != "" {
				if err := os.WriteFile(filepath.Join(dir, "mise"), []byte(tc.script), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			err := installTools()
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				if info, err := os.Stat(".terraform.d/plugin-cache"); err != nil || !info.IsDir() {
					t.Fatalf("plugin cache was not created: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v; want diagnostic %q", err, tc.want)
			}
			if tc.code != 0 {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) || exitErr.ExitCode() != tc.code {
					t.Fatalf("error lost installer exit code %d: %v", tc.code, err)
				}
			}
			if _, err := os.Stat(".terraform.d/plugin-cache"); !os.IsNotExist(err) {
				t.Fatal("failed install must not create the plugin cache")
			}
		})
	}
}
