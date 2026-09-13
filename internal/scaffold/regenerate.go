package scaffold

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/verify"
)

// CommittedValues computes the committed values every plain-Helm environment
// (localdev) would get for the plan's tier once the plan is applied: what
// `homelab config export --set <env> --format helm-<tier>` (task
// config:export:localdev) writes to charts/<tier>/values-<env>.yaml (ADR-011).
//
// The config pipeline runs over an overlay of configuration/ with the plan's
// changes applied, so it works before anything is written (--dry-run) and
// sees the new schema key and version pin. Changes whose content would not
// move are omitted.
func CommittedValues(root string, plan *Plan) ([]Change, error) {
	overlay, err := os.MkdirTemp("", "homelab-scaffold-config-")
	if err != nil {
		return nil, fmt.Errorf("creating config overlay: %w", err)
	}
	defer os.RemoveAll(overlay)

	src := filepath.Join(root, "configuration")
	if err := copyTree(src, filepath.Join(overlay, "configuration")); err != nil {
		return nil, fmt.Errorf("copying configuration/: %w", err)
	}
	for _, c := range plan.Changes {
		if !strings.HasPrefix(c.Path, "configuration/") {
			continue
		}
		dest := filepath.Join(overlay, filepath.FromSlash(c.Path))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(dest, c.New, 0o644); err != nil {
			return nil, err
		}
	}

	tier := plan.Options.Tier
	tmplPath := filepath.Join(overlay, "configuration", "templates", tierExport[tier])
	var out []Change
	for _, env := range verify.Envs {
		if env.TwoStage {
			continue
		}
		rc, err := resolveEnv(overlay, env)
		if err != nil {
			return nil, err
		}
		rendered, err := config.Export(rc, tmplPath)
		if err != nil {
			return nil, fmt.Errorf("exporting %s for %s: %w", tierExport[tier], env.Name, err)
		}
		rel := fmt.Sprintf("charts/%s/values-%s.yaml", tier, env.Name)
		old, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if err == nil && bytes.Equal(old, []byte(rendered)) {
			continue
		}
		out = append(out, Change{Path: rel, Old: old, New: []byte(rendered)})
	}
	return out, nil
}

// resolveEnv runs the config pipeline for one level-0 environment rooted at
// root (the repository or an overlay holding configuration/), reading the
// env's EnvFile exactly as level 0 does.
func resolveEnv(root string, env verify.Env) (*config.ResolvedConfig, error) {
	cfg := filepath.Join(root, "configuration")
	schema, err := config.LoadSchemaDir(filepath.Join(cfg, "schema"))
	if err != nil {
		return nil, fmt.Errorf("loading schemas: %w", err)
	}
	versions, err := config.LoadVersions(filepath.Join(cfg, "versions.yaml"))
	if err != nil {
		return nil, fmt.Errorf("loading versions: %w", err)
	}
	defaults, err := config.LoadEnvironment(filepath.Join(cfg, "environments", "defaults.yaml"))
	if err != nil {
		return nil, fmt.Errorf("loading defaults: %w", err)
	}
	values, err := config.LoadEnvironment(filepath.Join(root, filepath.FromSlash(env.EnvFile)))
	if err != nil {
		return nil, fmt.Errorf("loading %s: %w", env.EnvFile, err)
	}
	return config.Eval(schema, versions, env.ConfigSet, defaults, values)
}

// RegenerateSnapshots renders the plan's SnapshotCharts for every level-0
// environment and rewrites their golden snapshots, exactly as `homelab verify
// snapshot --update --chart <c>...` does. It returns the snapshot checks
// (detail "written (N bytes)" or "unchanged") and the render result; a render
// failure of those charts (see BlockingFailures) writes nothing and is
// reported through the result.
func RegenerateSnapshots(ctx context.Context, root string, plan *Plan, runner verify.Runner) ([]verify.Check, *verify.Result, error) {
	dir, err := os.MkdirTemp("", "homelab-scaffold-render-")
	if err != nil {
		return nil, nil, fmt.Errorf("creating render directory: %w", err)
	}
	defer os.RemoveAll(dir)

	out, res := verify.Render(ctx, verify.RenderOptions{
		RepoRoot:         root,
		OutDir:           dir,
		Charts:           plan.SnapshotCharts,
		SkipLint:         true,
		OmitSchemaChecks: true,
		Runner:           runner,
	})
	if len(BlockingFailures(res, plan.SnapshotCharts)) > 0 {
		return nil, res, nil
	}
	checks, err := verify.Snapshot(out.Files, filepath.Join(root, "tests", "snapshots"), true)
	if err != nil {
		return nil, res, fmt.Errorf("writing snapshots: %w", err)
	}
	return checks, res, nil
}

// copyTree copies a directory tree of regular files.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
}

// BlockingFailures returns the failing checks of a render pass that stop the
// snapshots of charts from being written: the renders of those charts and the
// per-env setup, config and inheritance steps they depend on. A failing
// render/<env>/_committed-values is not blocking: it compares files on disk
// with config export, which says nothing about these renders (and the
// scaffold has just regenerated its own tier's file).
func BlockingFailures(res *verify.Result, charts []string) []verify.Check {
	want := map[string]bool{}
	for _, c := range charts {
		want[c] = true
	}
	var out []verify.Check
	for _, c := range res.Checks {
		if c.Status != verify.StatusFail {
			continue
		}
		parts := strings.Split(c.Name, "/")
		if parts[0] != "render" || len(parts) < 3 {
			out = append(out, c)
			continue
		}
		last := parts[len(parts)-1]
		switch {
		case last == "_committed-values":
		case want[last], strings.HasPrefix(last, "_"):
			out = append(out, c)
		}
	}
	return out
}
