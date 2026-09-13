package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// Verification levels. Each level runs everything below it.
const (
	// levelStatic renders and lints every chart without a cluster.
	levelStatic = 0
	// levelDryRun adds a server-side dry run of the localdev render against Kind.
	levelDryRun = 1
	// levelLive adds ArgoCD Application state and the chainsaw e2e suite.
	levelLive = 2
)

// defaultKubeContext is the kubeconfig context `task localdev:kind` creates.
const defaultKubeContext = "kind-homelab-localdev"

// newVerifyAllCmd wires every check of a verification level into one command:
//
//	level 0: render → gitops graph → golden snapshots → conftest policy
//	level 1: level 0 → kubectl server-side dry run of the localdev render
//	level 2: level 1 → ArgoCD Application state → chainsaw e2e
//
// It is what `task verify` and `task verify LEVEL=1|2` run. Levels 1 and 2
// read the Kind cluster only (ADR-009); they never touch production.
func newVerifyAllCmd() *cobra.Command {
	var (
		level       int
		envList     string
		asJSON      bool
		keep        bool
		parallel    int
		outDir      string
		kubeContext string
		e2eDir      string
	)

	cmd := &cobra.Command{
		Use:   "all",
		Short: "Run every check for a verification level (0: static, 1: Kind dry-run, 2: Kind live)",
		Long: `Run every verification check for a level and emit one JSON summary.

Level 0 needs no cluster and reads no PII: every chart is rendered for localdev
and for homelab.yaml.example, then linted, schema-validated (kubeconform with the
vendored CRD schemas and the Kubernetes version from configuration/versions.yaml,
plus pluto), checked against the GitOps graph rules (tests/gitops/), diffed
against tests/snapshots/, and evaluated with the conftest policies in tests/policy/.

Level 1 runs level 0, then server-side dry-run applies every rendered localdev
chart against the Kind cluster selected by --kube-context (checks
dryrun/localdev/<chart>). The API server validates the objects against the
installed CRDs and admission webhooks, which catches what kubeconform cannot.
Requires --env to include localdev and a running Kind cluster (task localdev:up).

Level 2 runs level 1, then reads every ArgoCD Application in namespace argocd
(checks argocd/<app>: pass when Healthy and the last sync Succeeded) and runs the
chainsaw e2e suite in --e2e-dir (checks e2e/<test>). Requires task localdev:up
(or task localdev:ci) to have synced the cluster first.

Exit code 0 when every check passes, 1 when any check fails, 2 on usage error.`,
		Args:          UsageArgs(cobra.NoArgs),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if level < levelStatic || level > levelLive {
				return usageErrorf("--level must be 0, 1 or 2, got %d", level)
			}
			envs, err := verify.ParseEnvs(envList)
			if err != nil {
				return usageErrorf("%v", err)
			}
			if level >= levelDryRun && !hasEnv(envs, "localdev") {
				return usageErrorf("--level %d verifies the localdev render against Kind, so --env must include localdev (got %q)", level, envList)
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
			result := verify.NewResult(level)

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
				// Chart versions against configuration/versions.yaml
				// (versions/<env>, exceptions in tests/gitops/version-drift.yaml).
				result.Add(verify.VersionChecks(repoRoot, rendered, envs, len(envs) == len(verify.Envs))...)
			}

			// 3. Golden snapshots (compare only; `verify snapshot --update` rewrites).
			snapshotDir := filepath.Join(repoRoot, "tests", "snapshots")
			if checks, err := verify.Snapshot(out.Files, snapshotDir, false); err != nil {
				result.Add(verify.FailCheck("snapshot/compare", start, "comparing snapshots", err.Error()))
			} else {
				result.Add(checks...)
			}
			if len(envs) == len(verify.Envs) {
				expected := verify.ExpectedSnapshots(out.Envs, out.Charts)
				if checks, err := verify.OrphanSnapshots(expected, snapshotDir, verify.OrphanReport); err != nil {
					result.Add(verify.FailCheck("snapshot/orphans", start, "scanning for orphan snapshots", err.Error()))
				} else {
					result.Add(checks...)
				}
			}

			// 4. conftest policies.
			result.Add(verify.Policy(ctx, runner, dir, filepath.Join(repoRoot, "tests", "policy"), envs)...)

			// 5. Cluster-backed levels. Every check reads the Kind cluster
			// through the same Runner, so the fake in tests covers them too.
			if level >= levelDryRun {
				cluster := verify.ClusterOptions{
					Runner:      runner,
					RepoRoot:    repoRoot,
					RenderDir:   dir,
					KubeContext: kubeContext,
					E2EDir:      e2eDir,
				}
				result.Add(verify.DryRun(ctx, cluster)...)
				if level >= levelLive {
					result.Add(verify.ArgoCDApps(ctx, cluster)...)
					result.Add(verify.Chainsaw(ctx, cluster)...)
				}
			}

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

	cmd.Flags().IntVar(&level, "level", levelStatic, "Verification level: 0 = static (render, schema, gitops graph, snapshots, policy); 1 = level 0 + server-side dry run of the localdev render against Kind; 2 = level 1 + ArgoCD Application state + chainsaw e2e")
	cmd.Flags().StringVar(&envList, "env", "all", "Environments to verify (all, localdev, homelab, homelab-preview, or a comma-separated list); levels 1 and 2 need localdev")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the machine-readable result contract")
	cmd.Flags().BoolVar(&keep, "keep-render-dir", false, "Keep the temporary render directory and print its path")
	cmd.Flags().StringVar(&outDir, "out-dir", "", "Render into this directory instead of a temp dir (never pruned)")
	cmd.Flags().IntVar(&parallel, "parallel", 0, "Concurrent helm invocations (default: number of CPUs)")
	cmd.Flags().StringVar(&kubeContext, "kube-context", defaultKubeContext, "kubeconfig context of the Kind cluster read by levels 1 and 2")
	cmd.Flags().StringVar(&e2eDir, "e2e-dir", filepath.Join("tests", "e2e"), "Directory holding the chainsaw tests and .chainsaw.yaml for level 2 (relative to the repo root)")
	return cmd
}

// hasEnv reports whether envs contains the named environment.
func hasEnv(envs []verify.Env, name string) bool {
	for _, e := range envs {
		if e.Name == name {
			return true
		}
	}
	return false
}
