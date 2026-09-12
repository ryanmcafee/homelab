package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// newVerifyAllCmd wires every level-0 check into one command:
//
//	render → gitops graph → golden snapshots → conftest policy
//
// It is what `task verify` runs. Levels 1 (Kind dry-run) and 2 (Kind live)
// are reserved for Sections B and D of issue #261 and exit 2 until they land.
func newVerifyAllCmd() *cobra.Command {
	var (
		level    int
		envList  string
		asJSON   bool
		keep     bool
		parallel int
		outDir   string
	)

	cmd := &cobra.Command{
		Use:   "all",
		Short: "Run every check for a verification level (level 0: static, cluster-free)",
		Long: `Run every verification check for a level and emit one JSON summary.

Level 0 needs no cluster and reads no PII: every chart is rendered for localdev
and for homelab.yaml.example, then linted, schema-validated (kubeconform with the
vendored CRD schemas and the Kubernetes version from configuration/versions.yaml,
plus pluto), checked against the GitOps graph rules (tests/gitops/), diffed
against tests/snapshots/, and evaluated with the conftest policies in tests/policy/.

Exit code 0 when every check passes, 1 when any check fails, 2 on usage error.`,
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if level != 0 {
				return usageErrorf("level %d is not available yet: level 1 (Kind dry-run) and level 2 (Kind live) land with Sections B and D of issue #261; use --level 0", level)
			}
			envs, err := verify.ParseEnvs(envList)
			if err != nil {
				return usageErrorf("%v", err)
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			repoRoot, err := verify.FindRepoRoot(cwd)
			if err != nil {
				return err
			}

			dir := outDir
			if dir == "" {
				dir, err = os.MkdirTemp("", "homelab-verify-")
				if err != nil {
					return fmt.Errorf("creating render directory: %w", err)
				}
				if !keep {
					defer os.RemoveAll(dir)
				}
			}

			start := time.Now()
			ctx := cmd.Context()
			runner := verify.ExecRunner{}
			result := verify.NewResult(0)

			// 1. Render + lint + kubeconform + pluto.
			out, renderRes := verify.Render(ctx, verify.RenderOptions{
				RepoRoot: repoRoot,
				OutDir:   dir,
				Envs:     envs,
				Parallel: parallel,
				Runner:   runner,
			})
			result.Merge(renderRes)

			// 2. GitOps graph rules over the rendered objects.
			if reg, err := verify.LoadGitOpsRegistry(repoRoot); err != nil {
				result.Add(verify.FailCheck("gitops/registry", start, "loading tests/gitops registries", err.Error()))
			} else if rendered, err := verify.LoadRenderDir(dir); err != nil {
				result.Add(verify.FailCheck("gitops/load", start, "reading rendered manifests", err.Error()))
			} else {
				for _, env := range envs {
					result.Add(verify.LintGitOps(env.Name, rendered[env.Name], reg, repoRoot)...)
				}
			}

			// 3. Golden snapshots (compare only; `verify snapshot --update` rewrites).
			snapshotDir := filepath.Join(repoRoot, "tests", "snapshots")
			if checks, err := verify.Snapshot(out.Files, snapshotDir, false); err != nil {
				result.Add(verify.FailCheck("snapshot/compare", start, "comparing snapshots", err.Error()))
			} else {
				result.Add(checks...)
			}
			if len(envs) == len(verify.Envs) {
				expected := map[string][]string{}
				for _, env := range out.Envs {
					for _, c := range out.Charts {
						expected[env.Name] = append(expected[env.Name], c.Name)
					}
				}
				if checks, err := verify.OrphanSnapshots(expected, snapshotDir, verify.OrphanReport); err != nil {
					result.Add(verify.FailCheck("snapshot/orphans", start, "scanning for orphan snapshots", err.Error()))
				} else {
					result.Add(checks...)
				}
			}

			// 4. conftest policies.
			result.Add(verify.Policy(ctx, runner, dir, filepath.Join(repoRoot, "tests", "policy"), envs)...)

			result.Finalize(start)
			if asJSON {
				b, err := result.JSON()
				if err != nil {
					return err
				}
				fmt.Println(string(b))
			} else {
				result.WriteText(os.Stdout)
				if keep || outDir != "" {
					fmt.Fprintf(os.Stdout, "rendered manifests: %s\n", dir)
				}
			}
			if !result.Pass {
				return ErrVerificationFailed
			}
			return nil
		},
	}

	cmd.Flags().IntVar(&level, "level", 0, "Verification level: 0 = static (render, schema, gitops graph, snapshots, policy)")
	cmd.Flags().StringVar(&envList, "env", "all", "Environments to verify (all, localdev, homelab, or a comma-separated list)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the machine-readable result contract")
	cmd.Flags().BoolVar(&keep, "keep-render-dir", false, "Keep the temporary render directory and print its path")
	cmd.Flags().StringVar(&outDir, "out-dir", "", "Render into this directory instead of a temp dir (never pruned)")
	cmd.Flags().IntVar(&parallel, "parallel", 0, "Concurrent helm invocations (default: number of CPUs)")
	return cmd
}
