package commands

import (
	"fmt"
	"os"
	"time"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// newVerifyGitOpsCmd builds `homelab verify gitops`: a cluster-free linter
// over the rendered ArgoCD Application graph. It reads manifests the renderer
// already wrote to disk (<render-dir>/<env>/<chart>.yaml) so rendering and
// linting stay independently runnable and independently cacheable.
func newVerifyGitOpsCmd() *cobra.Command {
	var (
		renderDir string
		envList   string
		asJSON    bool
	)

	cmd := &cobra.Command{
		Use:   "gitops",
		Short: "Lint the rendered ArgoCD Application graph",
		Long: `Lint the rendered ArgoCD Application graph (level 0, no cluster needed).

Rules, one check each, named gitops/<env>/<rule>:

  paths         every Application source path and Helm value file exists
  waves         <chart>-dependencies syncs earlier and <chart>-config never
                shares its chart's wave
  crd-order     every custom resource syncs after the Application providing
                its CRDs, comparing (parent wave, wave)
  repo-secrets  every OCI chart repository has an ArgoCD repository Secret
                with enableOCI: "true"
  secret-refs   every consumed Secret is produced in the same namespace by a
                rendered Secret, OnePasswordItem or Certificate, or is
                registered in tests/gitops/known-secrets.yaml
  namespaces    every destination namespace is rendered, created via
                CreateNamespace=true, or a system namespace
  ssa           charts with oversized CRDs set ServerSideApply=true
  unique-names  no two Applications share namespace/name

The registries under tests/gitops/ declare the facts the manifests cannot:
CRD providers, oversized-CRD charts, system namespaces and the Secrets
created outside the rendered charts.

Exit codes: 0 all checks passed, 1 a check failed, 2 the command was
invoked wrongly.`,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return NewUsageError(fmt.Errorf("unexpected argument %q", args[0]))
			}
			if renderDir == "" {
				return NewUsageError(fmt.Errorf("--render-dir is required: render first with `homelab verify render --out <dir>`"))
			}

			envs, err := verify.ParseEnvs(envList)
			if err != nil {
				return NewUsageError(err)
			}

			if fi, serr := os.Stat(renderDir); serr != nil || !fi.IsDir() {
				return NewUsageError(fmt.Errorf("--render-dir %q is not a directory", renderDir))
			}

			wd, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("resolving working directory: %w", err)
			}
			repoRoot, err := verify.FindRepoRoot(wd)
			if err != nil {
				return err
			}

			reg, err := verify.LoadGitOpsRegistry(repoRoot)
			if err != nil {
				return fmt.Errorf("loading GitOps registry: %w", err)
			}

			rendered, err := verify.LoadRenderDir(renderDir)
			if err != nil {
				return fmt.Errorf("reading rendered manifests from %s: %w", renderDir, err)
			}

			start := time.Now()
			result := verify.NewResult(0)
			for _, env := range envs {
				charts, ok := rendered[env.Name]
				if !ok || len(charts) == 0 {
					for _, rule := range verify.GitOpsRules {
						result.Add(verify.SkipCheck(
							"gitops/"+env.Name+"/"+rule,
							fmt.Sprintf("no rendered manifests under %s/%s", renderDir, env.Name)))
					}
					continue
				}
				result.Add(verify.LintGitOps(env.Name, charts, reg, repoRoot)...)
			}
			result.Finalize(start)

			if asJSON {
				data, jerr := result.JSON()
				if jerr != nil {
					return jerr
				}
				fmt.Fprintln(cmd.OutOrStdout(), string(data))
			} else {
				result.WriteText(cmd.OutOrStdout())
			}

			if !result.Pass {
				_, fail, _ := result.Counts()
				return fmt.Errorf("%d GitOps graph check(s) failed", fail)
			}
			return nil
		},
	}

	cmd.Flags().StringVar(&renderDir, "render-dir", "", "Directory of rendered manifests (<dir>/<env>/<chart>.yaml)")
	cmd.Flags().StringVar(&envList, "env", "", "Comma-separated environments to lint (default: all)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the machine-readable result contract")
	cmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return NewUsageError(err) })

	return cmd
}
