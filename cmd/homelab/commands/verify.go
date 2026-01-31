package commands

import (
	"fmt"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

func NewVerifyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "verify",
		Short: "Verification utilities",
		Long:  `Verify GPU support, Cilium migration, etc.`,
	}

	cmd.AddCommand(newVerifyGPUCmd())
	cmd.AddCommand(newVerifyCiliumCmd())

	return cmd
}

func newVerifyGPUCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "gpu",
		Short: "Verify GPU support",
		Long:  `Verify NVIDIA GPU support in Talos cluster`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			logger.Info("======================================")
			logger.Info("  GPU Support Verification")
			logger.Info("======================================")
			fmt.Println()

			logger.Warn("GPU verification implementation pending - feature deferred to future iteration")
			logger.Info("Would verify:")
			logger.Info("  - NVIDIA kernel modules loaded")
			logger.Info("  - RuntimeClass 'nvidia' exists")
			logger.Info("  - GPU operator pods healthy")
			logger.Info("  - GPU resources advertised by node")
			logger.Info("  - nvidia-smi works in container")

			return nil
		},
	}
}

func newVerifyCiliumCmd() *cobra.Command {
	var phase string

	cmd := &cobra.Command{
		Use:   "cilium",
		Short: "Verify Cilium LB migration",
		Long:  `Verify MetalLB to Cilium LB IPAM migration`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			logger.Info("======================================")
			logger.Info("  Cilium LB Migration Verification")
			logger.Info("======================================")
			logger.Info(fmt.Sprintf("  Phase: %s", phase))
			logger.Info("======================================")
			fmt.Println()

			logger.Warn("Cilium verification implementation pending - feature deferred to future iteration")
			logger.Info("Phases:")
			logger.Info("  pre-migration  - Establish baseline")
			logger.Info("  post-cilium    - Verify Cilium BGP")
			logger.Info("  post-removal   - Verify MetalLB removed")

			return nil
		},
	}

	cmd.Flags().StringVar(&phase, "phase", "pre-migration", "Migration phase to verify")

	return cmd
}
