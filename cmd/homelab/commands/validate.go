package commands

import (
	"fmt"
	"io"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/prereq"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

// prereqEnv is the machine the prerequisite checks probe. Tests swap in a
// fake so no row depends on what is installed on the runner.
var prereqEnv prereq.Env = prereq.RealEnv{}

const (
	markPass = "✔"
	markFail = "✘"
)

func NewValidateCmd() *cobra.Command {
	var environment string

	cmd := &cobra.Command{
		Use:   "validate",
		Short: "Validate prerequisites for a tier (localdev or homelab)",
		Long: `Checks every prerequisite the selected tier needs and prints one row per
check: ` + markPass + ` when it passes, ` + markFail + ` with a fix hint when it fails.

  localdev  mise, task, bun, docker (daemon reachable), kind, kubectl, helm,
            argocd, chainsaw
  homelab   the localdev rows plus terragrunt, talosctl, ansible-playbook,
            op (signed in), the SOPS age key, configuration/environments/
            homelab.yaml (present and schema-valid) and Proxmox on TCP 8006

Exits 1 when any row fails.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			tier, err := prereq.ParseTier(environment)
			if err != nil {
				return NewUsageError(err)
			}

			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "Prerequisites for %s\n\n", tier)
			results := prereq.RunChecks(prereqEnv, tier)
			printPrereqTable(out, results)

			failed := prereq.Failed(results)
			if failed > 0 {
				return fmt.Errorf("%d of %d prerequisite checks failed for %s", failed, len(results), tier)
			}
			logger.OK(fmt.Sprintf("All %d prerequisite checks passed for %s", len(results), tier))
			fmt.Fprintln(out)
			fmt.Fprintln(out, "Next steps:")
			if tier == prereq.Localdev {
				fmt.Fprintln(out, "  task localdev:up          # Kind + ArgoCD loop from the working tree")
				fmt.Fprintln(out, "  ./bin/homelab validate -e homelab   # check the production prerequisites")
			} else {
				fmt.Fprintln(out, "  ./bin/homelab bootstrap -e homelab")
			}
			return nil
		},
	}

	cmd.Flags().StringVarP(&environment, "environment", "e", string(prereq.Localdev), "Tier to validate (localdev|homelab)")

	return cmd
}

// printPrereqTable writes one line per result: mark, name, and on failure the
// error and the fix hint.
func printPrereqTable(w io.Writer, results []prereq.Result) {
	width := 0
	for _, r := range results {
		if len(r.Name) > width {
			width = len(r.Name)
		}
	}
	for _, r := range results {
		if r.Err == nil {
			fmt.Fprintf(w, "  %s  %s\n", markPass, r.Name)
			continue
		}
		fmt.Fprintf(w, "  %s  %-*s  %v\n", markFail, width, r.Name, r.Err)
		fmt.Fprintf(w, "     %-*s  fix: %s\n", width, "", r.Hint)
	}
	fmt.Fprintln(w)
}
