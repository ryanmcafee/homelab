package commands

import (
	"fmt"
	"os"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

func NewValidateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "validate",
		Short: "Validate prerequisites using mise",
		Long:  `Validates that all required tools are installed and environment is configured correctly.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			logger.Info("==================================")
			logger.Info("Homelab Prerequisites Validation")
			logger.Info("==================================")
			fmt.Println()

			// Check if mise is installed
			result, err := utils.ExecCommand("mise", "--version")
			if err != nil || !result.Success {
				logger.Error("mise is not installed")
				logger.Info("Run ./homelab bootstrap to install mise and all dependencies")
				return fmt.Errorf("mise not found")
			}
			logger.OK(fmt.Sprintf("mise is installed (%s)", result.Stdout))
			fmt.Println()

			// Check mise doctor output
			logger.Info("Running mise doctor...")
			fmt.Println()
			result, err = utils.ExecCommand("mise", "doctor")
			if err != nil || !result.Success {
				fmt.Println()
				logger.Warn("mise doctor found some issues (may be non-critical)")
			} else {
				fmt.Println()
				logger.OK("mise doctor passed")
			}

			fmt.Println()
			logger.Info("==================================")
			logger.Info("Validating individual tools...")
			logger.Info("==================================")
			fmt.Println()

			// Run mise validation task
			result, err = utils.ExecCommand("mise", "run", "validate")
			if err != nil || !result.Success {
				logger.Error("Tool validation failed")
				logger.Info("Run 'mise install -y' to install missing tools")
				return fmt.Errorf("validation failed")
			}
			logger.OK("All tools validated successfully")

			fmt.Println()
			logger.Info("==================================")
			logger.Info("Environment Configuration")
			logger.Info("==================================")
			fmt.Println()

			if utils.FileExists(".envrc") {
				logger.OK(".envrc file exists")
				if os.Getenv("TF_VAR_proxmox_api_url") != "" {
					logger.OK("Environment variables loaded")
				} else {
					logger.Warn(".envrc exists but not loaded")
					logger.Info("  Run 'direnv allow' to load environment variables")
				}
			} else {
				logger.Warn(".envrc file not found")
				logger.Info("  Copy .envrc.example to .envrc and configure for homelab")
				logger.Info("  Required for Proxmox deployments")
			}

			fmt.Println()
			logger.Info("==================================")
			logger.Info("External Prerequisites")
			logger.Info("==================================")
			fmt.Println()

			result, err = utils.ExecCommand("docker", "--version")
			if err != nil || !result.Success {
				logger.Warn("Docker is not installed")
				logger.Info("  Docker is required for local development (Kind)")
				logger.Info("  Install Docker Desktop: https://www.docker.com/products/docker-desktop")
			} else {
				logger.OK(fmt.Sprintf("Docker is installed (%s)", result.Stdout))
			}

			fmt.Println()
			logger.OK("Prerequisites validation complete!")
			fmt.Println()

			logger.Info("Next steps:")
			logger.Info("  For local development: task localdev:up")
			logger.Info("  For production setup: ./homelab bootstrap")
			fmt.Println()

			return nil
		},
	}
}
