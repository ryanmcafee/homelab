package commands

import (
	"fmt"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

func NewSopsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sops",
		Short: "SOPS encryption management",
		Long:  `Manage SOPS encryption keys and setup for GitOps secrets.`,
	}

	cmd.AddCommand(newSopsBootstrapCmd())
	cmd.AddCommand(newSopsSetupCmd())

	return cmd
}

func newSopsBootstrapCmd() *cobra.Command {
	var force, encrypt bool

	cmd := &cobra.Command{
		Use:   "bootstrap",
		Short: "Bootstrap SOPS encryption",
		Long:  `Generate age keys, store in 1Password, and configure .sops.yaml`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun
			utils.AutoAccept = AutoAccept

			logger.Info("=== SOPS Bootstrap ===")
			fmt.Println()

			// Check prerequisites
			logger.Info("Checking prerequisites...")
			if err := checkToolInstalled("age-keygen"); err != nil {
				logger.Error("age is not installed. Install with: mise install")
				return err
			}
			if err := checkToolInstalled("sops"); err != nil {
				logger.Error("sops is not installed. Install with: mise install")
				return err
			}
			if err := check1PasswordAuth(); err != nil {
				logger.Error("1Password CLI not authenticated. Run: eval $(op signin)")
				return err
			}
			logger.OK("Prerequisites OK")

			logger.Info("SOPS bootstrap would:")
			logger.Info("  1. Generate age key pair")
			logger.Info("  2. Store keys in 1Password")
			logger.Info("  3. Update .sops.yaml")
			logger.Info("  4. Create credentials template")
			if encrypt {
				logger.Info("  5. Encrypt credentials (--encrypt flag)")
			}

			logger.Warn("SOPS bootstrap implementation pending - feature deferred to future iteration")
			return nil
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Regenerate keys even if they exist")
	cmd.Flags().BoolVar(&encrypt, "encrypt", false, "Encrypt the 1Password credentials after setup")

	return cmd
}

func newSopsSetupCmd() *cobra.Command {
	var commit bool

	cmd := &cobra.Command{
		Use:   "setup",
		Short: "Setup SOPS-encrypted 1Password credentials",
		Long:  `Pull credentials from 1Password and encrypt with SOPS`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun
			utils.AutoAccept = AutoAccept

			logger.Info("=== SOPS 1Password Credentials Setup ===")
			fmt.Println()

			logger.Info("Checking prerequisites...")
			if err := check1PasswordAuth(); err != nil {
				logger.Error("1Password CLI not authenticated. Run: eval $(op signin)")
				return err
			}
			logger.OK("Prerequisites OK")

			logger.Warn("SOPS setup implementation pending - feature deferred to future iteration")
			return nil
		},
	}

	cmd.Flags().BoolVar(&commit, "commit", false, "Commit the encrypted secret after creation")

	return cmd
}

func checkToolInstalled(tool string) error {
	result, err := utils.ExecCommand("which", tool)
	if err != nil || !result.Success {
		return fmt.Errorf("%s not found", tool)
	}
	return nil
}

func check1PasswordAuth() error {
	result, err := utils.ExecCommand("op", "whoami")
	if err != nil || !result.Success {
		return fmt.Errorf("1Password CLI not authenticated")
	}
	return nil
}
