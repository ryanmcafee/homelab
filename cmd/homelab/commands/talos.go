package commands

import (
	"fmt"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

func NewTalosCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "talos",
		Short: "Talos node operations",
		Long:  `Manage Talos nodes - recreation, upgrades, etc.`,
	}

	cmd.AddCommand(newTalosRecreateCmd())

	return cmd
}

func newTalosRecreateCmd() *cobra.Command {
	var node string
	var skipDrain bool

	cmd := &cobra.Command{
		Use:   "recreate",
		Short: "Recreate a Talos node",
		Long:  `Drain, taint, and recreate a Talos node via terragrunt`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun
			utils.AutoAccept = AutoAccept

			logger.Info("======================================")
			logger.Info("  Talos Node Recreation")
			logger.Info("======================================")
			logger.Info(fmt.Sprintf("  Node: %s", node))
			logger.Info(fmt.Sprintf("  Skip Drain: %t", skipDrain))
			logger.Info(fmt.Sprintf("  Dry Run: %t", DryRun))
			logger.Info("======================================")
			fmt.Println()

			logger.Warn("Talos recreate implementation pending - feature deferred to future iteration")
			logger.Info("Would perform:")
			logger.Info("  1. Pre-flight checks")
			logger.Info("  2. Cordon node")
			if !skipDrain {
				logger.Info("  3. Drain node")
			}
			logger.Info("  4. Taint terraform resource")
			logger.Info("  5. Apply terragrunt")
			logger.Info("  6. Wait for node to rejoin cluster")
			logger.Info("  7. Uncordon node")

			return nil
		},
	}

	cmd.Flags().StringVar(&node, "node", "worker-1", "Node to recreate")
	cmd.Flags().BoolVar(&skipDrain, "skip-drain", false, "Skip draining the node")

	return cmd
}
