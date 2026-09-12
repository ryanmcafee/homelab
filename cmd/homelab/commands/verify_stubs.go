package commands

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Level-0 verification subcommands. Each is implemented in its own file
// (verify_render.go, verify_gitops.go, verify_snapshot.go, verify_all.go);
// the stubs below are replaced as each lands.

func stubCmd(use, short string) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short + " (not implemented yet)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("%s: not implemented", use)
		},
	}
}

func newVerifyRenderCmd() *cobra.Command {
	return stubCmd("render", "Render, lint and schema-validate every chart")
}
func newVerifyGitOpsCmd() *cobra.Command {
	return stubCmd("gitops", "Lint the rendered ArgoCD Application graph")
}
func newVerifySnapshotCmd() *cobra.Command {
	return stubCmd("snapshot", "Diff rendered charts against golden snapshots")
}
func newVerifyAllCmd() *cobra.Command {
	return stubCmd("all", "Run every check for a verification level")
}
