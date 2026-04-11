package commands

import (
	"fmt"
	"os"
	"strings"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

func NewBootstrapCmd() *cobra.Command {
	var environment string

	cmd := &cobra.Command{
		Use:   "bootstrap",
		Short: "Bootstrap the homelab environment",
		Long:  `Installs mise, tools, validates prerequisites, and sets up the environment (localdev or homelab).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun
			utils.AutoAccept = AutoAccept

			logger.Info("======================================")
			logger.Info("  Homelab Infrastructure Setup")
			logger.Info("======================================")
			fmt.Println()

			// Step 0: Install mise
			if err := installMise(); err != nil {
				logger.Error("Failed to install mise")
				return err
			}

			// Step 1: Install tools via mise
			if err := installTools(); err != nil {
				logger.Error("Tool installation failed")
				return err
			}

			// Step 2: Validate prerequisites
			logger.Info("Validating prerequisites...")
			result, err := utils.ExecCommand("mise", "doctor")
			if err != nil || !result.Success {
				logger.Warn("mise doctor found some issues (may be non-critical)")
			} else {
				logger.OK("Prerequisites validated")
			}
			fmt.Println()

			// Step 3: Check environment
			logger.Info("Checking environment configuration...")
			if os.Getenv("TF_VAR_proxmox_api_url") == "" {
				logger.Warn("Environment variables not set")
				logger.Info("Please copy .envrc.example to .envrc and fill in your values")
				logger.Info("Then run: direnv allow")
				if !utils.Confirm("Continue without environment variables?") {
					return fmt.Errorf("aborted by user")
				}
			}
			logger.OK("Environment checked")
			fmt.Println()

			// Step 4: Setup Ansible vault password
			if err := setupAnsibleVault(); err != nil {
				logger.Warn(fmt.Sprintf("Ansible vault setup warning: %v", err))
			}

			// Step 5: Determine environment
			if environment == "" && !AutoAccept {
				options := []string{
					"localdev  - Local Kind cluster (no hardware required)",
					"homelab   - Homelab environment (Proxmox)",
				}
				choice := utils.PromptSelect("Select deployment target:", options, 1)
				if choice == 0 {
					environment = "localdev"
				} else {
					environment = "homelab"
				}
			} else if environment == "" {
				environment = "homelab"
			}
			logger.Info(fmt.Sprintf("Using environment: %s", environment))
			fmt.Println()

			// Step 6: Execute deployment based on environment
			if err := deployEnvironment(environment); err != nil {
				return err
			}

			logger.OK("Setup complete!")
			printNextSteps(environment)

			return nil
		},
	}

	cmd.Flags().StringVarP(&environment, "environment", "e", "", "Set environment (localdev|homelab)")

	return cmd
}

func installMise() error {
	logger.Info("Checking for mise...")
	result, err := utils.ExecCommand("mise", "--version")
	if err == nil && result.Success {
		logger.OK(fmt.Sprintf("mise is already installed (%s)", strings.TrimSpace(result.Stdout)))
		return nil
	}

	logger.Info("mise not found - installing...")
	if DryRun {
		logger.Warn("Would install mise via curl https://mise.run | sh")
		return nil
	}

	// Download and execute mise installer
	result, err = utils.ExecCommand("sh", "-c", "curl https://mise.run | sh")
	if err != nil || !result.Success {
		return fmt.Errorf("failed to install mise: %v", err)
	}

	logger.OK("mise installed successfully")
	logger.Warn("mise activated for this session")
	logger.Info("To make this permanent, add to your shell rc file:")
	logger.Info(`  eval "$(~/.local/bin/mise activate bash)"`)
	fmt.Println()

	return nil
}

func installTools() error {
	logger.Info("Installing all dependencies via mise...")
	result, err := utils.ExecCommand("mise", "install", "-y")
	if err != nil || !result.Success {
		logger.Error("mise installation failed")
		logger.Info("Run 'mise doctor' for diagnostics")
		return fmt.Errorf("mise install failed")
	}
	logger.OK("All tools installed via mise")

	// Create Terraform plugin cache directory
	logger.Info("Setting up Terraform plugin cache...")
	if err := utils.CreateDir(".terraform.d/plugin-cache"); err != nil {
		logger.Warn(fmt.Sprintf("Failed to create Terraform plugin cache: %v", err))
	} else {
		logger.OK("Terraform plugin cache directory created")
	}

	return nil
}

func setupAnsibleVault() error {
	home, err := utils.HomeDir()
	if err != nil {
		return err
	}

	vaultPasswordFile := utils.JoinPath(home, ".ansible_vault_password")

	if utils.FileExists(vaultPasswordFile) {
		logger.OK("Ansible vault password file exists")
		return nil
	}

	logger.Info("Creating Ansible vault password file...")
	if DryRun {
		logger.Warn(fmt.Sprintf("Would create Ansible vault password at %s", vaultPasswordFile))
		return nil
	}

	result, err := utils.ExecCommand("openssl", "rand", "-base64", "32")
	if err != nil || !result.Success {
		return fmt.Errorf("failed to generate vault password: %v", err)
	}

	if err := os.WriteFile(vaultPasswordFile, []byte(result.Stdout), 0600); err != nil {
		return fmt.Errorf("failed to write vault password: %v", err)
	}

	logger.OK(fmt.Sprintf("Created Ansible vault password at %s", vaultPasswordFile))
	logger.Warn("Save this password for your records if you plan to create encrypted vault files")

	return nil
}

func deployEnvironment(env string) error {
	switch env {
	case "localdev":
		return deployLocaldev()
	case "homelab":
		return deployHomelab()
	default:
		return fmt.Errorf("unknown environment: %s", env)
	}
}

func deployLocaldev() error {
	logger.Info("Creating Kind cluster...")
	result, err := utils.ExecCommand("task", "localdev:kind")
	if err != nil || !result.Success {
		return fmt.Errorf("failed to create Kind cluster: %v", err)
	}
	logger.OK("Kind cluster created")
	fmt.Println()

	logger.Info("Tilt will start in the background")
	logger.Info("Access Tilt UI at: http://localhost:10350")
	logger.Info("Services will be available at:")
	logger.Info("  - ArgoCD:  http://localhost:8080")
	logger.Info("  - Traefik: http://localhost:9080")
	logger.Info("  - Grafana: http://localhost:3000")
	fmt.Println()

	if utils.Confirm("Start Tilt now?") {
		result, err = utils.ExecCommand("tilt", "up")
		if err != nil || !result.Success {
			logger.Warn("Failed to start Tilt. Run 'task localdev:tilt' manually")
		}
	} else {
		logger.Info("Run 'task localdev:tilt' to start Tilt later")
	}

	return nil
}

func deployHomelab() error {
	logger.Info("Phase 1: Proxmox Installation")
	logger.Info("This phase must be completed manually.")
	logger.Info("See plan.md Phase 1 for detailed instructions.")
	fmt.Println()

	if !utils.Confirm("Has Proxmox been installed and is accessible?") {
		logger.Warn("Please install Proxmox first")
		return fmt.Errorf("aborted by user")
	}
	logger.OK("Proxmox installation confirmed")
	fmt.Println()

	logger.Info("Phase 2: Proxmox Configuration (Ansible)")
	if utils.Confirm("Run Ansible playbooks to configure Proxmox?") {
		result, err := utils.ExecCommand("ansible-playbook", "playbooks/site.yml")
		if err != nil || !result.Success {
			logger.Warn("Ansible configuration failed")
			logger.Info("Run manually: task ansible:apply")
		} else {
			logger.OK("Proxmox configured via Ansible")
		}
	} else {
		logger.Warn("Skipped Ansible configuration")
		logger.Info("Run manually: task ansible:apply")
	}
	fmt.Println()

	logger.Info("Phase 3: Infrastructure Provisioning (Terragrunt)")
	if utils.Confirm("Run Terragrunt to provision infrastructure?") {
		args := []string{"run", "--all", "apply"}
		if AutoAccept {
			args = append(args, "--non-interactive")
		}
		result, err := utils.ExecCommand("terragrunt", args...)
		if err != nil || !result.Success {
			logger.Warn("Terragrunt provisioning failed")
			logger.Info("Run manually: task tf:apply ENV=homelab")
		} else {
			logger.OK("Infrastructure provisioned via Terragrunt")
		}
	} else {
		logger.Warn("Skipped Terragrunt provisioning")
		logger.Info("Run manually: task tf:apply ENV=homelab")
	}
	fmt.Println()

	logger.Info("Phase 4: GitOps Bootstrap")
	logger.Info("ArgoCD should now be deployed and managing the cluster")
	fmt.Println()

	retrieveArgoCDPassword()

	return nil
}

func retrieveArgoCDPassword() {
	logger.Info("Retrieving ArgoCD admin password...")
	result, err := utils.ExecCommand("kubectl", "-n", "argocd", "get", "secret", "argocd-initial-admin-secret", "-o", "jsonpath={.data.password}")
	if err != nil || !result.Success || result.Stdout == "" {
		logger.Warn("Could not retrieve ArgoCD password (may not be deployed yet)")
		return
	}

	// Decode base64
	decodeResult, err := utils.ExecCommandWithStdin(result.Stdout, "base64", "-d")
	if err != nil || !decodeResult.Success {
		logger.Warn("Failed to decode ArgoCD password")
		return
	}

	fmt.Println()
	logger.OK(fmt.Sprintf("ArgoCD admin password: %s", strings.TrimSpace(decodeResult.Stdout)))
	logger.Info("Access ArgoCD at: https://argocd.ryanmcafee.com")
	logger.Info("Username: admin")
	fmt.Println()
}

func printNextSteps(env string) {
	fmt.Println()
	logger.Info("Next steps:")
	if env == "localdev" {
		fmt.Println("  1. Check Tilt UI for deployment status")
		fmt.Println("  2. Access ArgoCD to see GitOps in action")
		fmt.Println("  3. Make changes to charts/ and see live updates")
		fmt.Println()
		fmt.Println("Useful commands:")
		fmt.Println("  task localdev:logs    - Stream logs from all pods")
		fmt.Println("  task localdev:down    - Tear down environment")
		fmt.Println("  task chart:lint       - Lint Helm charts")
	} else {
		fmt.Println("  1. Verify cluster health: kubectl get nodes")
		fmt.Println("  2. Check ArgoCD applications: kubectl get applications -n argocd")
		fmt.Println("  3. Monitor pod deployments: kubectl get pods -A")
		fmt.Println("  4. Access ArgoCD UI to see GitOps status")
		fmt.Println()
		fmt.Println("Useful commands:")
		fmt.Println("  task k8s:status       - Show cluster status")
		fmt.Println("  task k8s:argocd-password - Get ArgoCD admin password")
	}
	fmt.Println()
}
