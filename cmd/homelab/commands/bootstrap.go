package commands

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/prereq"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

const (
	docProvisioning        = "docs/architecture.md#provisioning"
	docControlPlaneStorage = "docs/runbooks/control-plane-storage.md"
	docLocalDevelopment    = "docs/local-development.md"
)

func NewBootstrapCmd() *cobra.Command {
	var environment string

	cmd := &cobra.Command{
		Use:   "bootstrap",
		Short: "Bootstrap a tier: the Kind loop (localdev) or production (homelab)",
		Long: `Installs mise and the pinned tools, picks a tier, checks that tier's
prerequisites and runs its setup through the Taskfile.

Tier selection: one prompt, Kind loop or production, default localdev.
Production is suggested as the default only when configuration/environments/
homelab.yaml exists and Proxmox answers on TCP 8006; detection never selects
it. --environment makes the tier explicit. --yes skips the confirmations
inside the chosen tier only: --yes without --environment is localdev, so no
bare invocation reaches terragrunt apply.

  localdev  task localdev:up, task localdev:wait, then the ArgoCD access hint
  homelab   Proxmox installed? -> task ansible:apply -> task tf:apply
            ENV=homelab -> GitOps takes over`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun
			utils.AutoAccept = AutoAccept

			// Reject a bad --environment before installing anything.
			if environment != "" {
				if _, err := prereq.ParseTier(environment); err != nil {
					return NewUsageError(err)
				}
			}

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

			// Step 2: Pick the tier. Detection only sets the prompt default.
			opts := prereq.DefaultOptions()
			detected := prereq.DetectTier(prereqEnv, opts.HomelabConfigPath(), prereq.ProxmoxAddr(opts))
			tier, err := prereq.ResolveTier(environment, AutoAccept, detected, promptTier)
			if err != nil {
				return NewUsageError(err)
			}
			logger.Info(fmt.Sprintf("Using environment: %s (detected default: %s)", tier, detected))
			fmt.Println()

			// Step 3: Check the tier's prerequisites.
			logger.Info(fmt.Sprintf("Checking %s prerequisites...", tier))
			results := prereq.RunChecks(prereqEnv, tier)
			printPrereqTable(cmd.OutOrStdout(), results)
			if failed := prereq.Failed(results); failed > 0 {
				logger.Error(fmt.Sprintf("%d of %d prerequisite checks failed for %s", failed, len(results), tier))
				logger.Info(fmt.Sprintf("Fix the rows marked %s above (each shows its fix), then rerun; ./bin/homelab validate -e %s rechecks them", markFail, tier))
				return fmt.Errorf("%d prerequisite checks failed for %s", failed, tier)
			}
			logger.OK("Prerequisites validated")
			fmt.Println()

			// Step 4: Run the tier.
			switch tier {
			case prereq.Localdev:
				if err := deployLocaldev(); err != nil {
					return err
				}
			case prereq.Homelab:
				if err := deployHomelab(opts); err != nil {
					return err
				}
			}

			logger.OK("Setup complete!")
			printNextSteps(tier)

			return nil
		},
	}

	cmd.Flags().StringVarP(&environment, "environment", "e", "", "Tier to bootstrap (localdev|homelab); default: prompt, or localdev with --yes")

	return cmd
}

// tierPromptOptions lists the tiers for the prompt, localdev first, and the
// default index for the detected tier.
func tierPromptOptions(detected prereq.Tier) ([]string, int) {
	options := []string{
		"localdev  - Kind + ArgoCD loop on this machine (no hardware required)",
		"homelab   - Production: Proxmox, Talos, Terragrunt",
	}
	idx := 0
	if detected == prereq.Homelab {
		idx = 1
	}
	return options, idx
}

func tierFromChoice(idx int) prereq.Tier {
	if idx == 1 {
		return prereq.Homelab
	}
	return prereq.Localdev
}

func promptTier(detected prereq.Tier) prereq.Tier {
	options, idx := tierPromptOptions(detected)
	return tierFromChoice(utils.PromptSelect("Select deployment target:", options, idx))
}

// runTask runs `task <args>` with stdout and stderr streamed to the terminal,
// because the Kind loop and terragrunt run for minutes and the operator needs
// to see progress. Honors --dry-run like utils.ExecCommand.
func runTask(args ...string) error {
	if DryRun {
		logger.Warn(fmt.Sprintf("Would run: task %s", strings.Join(args, " ")))
		return nil
	}
	cmd := exec.Command("task", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("task %s: %w", strings.Join(args, " "), err)
	}
	return nil
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
		// ExecCommand captures stderr; include it in the returned error so the
		// CLI prints mise's tool name and root cause instead of losing them.
		if err != nil {
			return fmt.Errorf("mise install failed: %w\n%s", err, strings.TrimSpace(result.Stderr))
		}
		return fmt.Errorf("mise install failed (exit %d): %s", result.Code, strings.TrimSpace(result.Stderr))
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

// deployLocaldev runs the Kind + ArgoCD loop through the Taskfile and waits
// until every Application is Healthy.
func deployLocaldev() error {
	logger.Info("Phase 1: Kind + ArgoCD loop (task localdev:up)")
	logger.Info("  Kind (Cilium, registry caches, fakes) -> ArgoCD -> every Application synced from the working tree")
	logger.Info("  See " + docLocalDevelopment)
	fmt.Println()
	if err := runTask("localdev:up"); err != nil {
		logger.Error("The Kind loop did not come up")
		logger.Info("Inspect with: task localdev:diagnose; retry with: task localdev:up")
		return err
	}
	logger.OK("Kind cluster and ArgoCD are up")
	fmt.Println()

	logger.Info("Phase 2: waiting for every Application to be Healthy (task localdev:wait)")
	if err := runTask("localdev:wait"); err != nil {
		logger.Error("Not every Application became Healthy")
		logger.Info("Inspect with: task localdev:diagnose; re-sync one app with: task localdev:sync -- --only <app>")
		return err
	}
	logger.OK("Every Application is Healthy")
	fmt.Println()

	printLocaldevAccess()
	return nil
}

// printLocaldevAccess prints how the loop exposes ArgoCD (docs/local-development.md).
func printLocaldevAccess() {
	logger.Info("ArgoCD UI: http://localhost:8080 (user admin)")
	logger.Info("  macOS: task localdev:ui       # kubectl port-forward to argocd-server; keep it running")
	logger.Info("  Linux: the Kind port mapping (NodePort 30080 -> host 8080) serves it directly")
	logger.Info("  Password: task k8s:argocd-password")
	fmt.Println()
}

// deployHomelab walks the four production phases through the Taskfile so the
// 1Password wiring (op run, rendered-file sync) is never bypassed.
func deployHomelab(opts prereq.Options) error {
	logger.Info("Phase 1: Proxmox installation")
	logger.Info("  Proxmox VE is installed by hand on the host; the rest is automated from here.")
	logger.Info("  See " + docProvisioning)
	fmt.Println()

	if !utils.Confirm("Has Proxmox been installed and is it accessible?") {
		logger.Warn("Install Proxmox first, then rerun ./bin/homelab bootstrap -e homelab")
		return fmt.Errorf("aborted by user")
	}
	logger.OK("Proxmox installation confirmed")
	fmt.Println()

	logger.Info("Phase 2: Proxmox configuration (Ansible: task ansible:apply)")
	logger.Info("  Runs ansible/playbooks/site.yml against the Proxmox host.")
	logger.Info("  See " + docProvisioning)
	if utils.Confirm("Run Ansible to configure Proxmox?") {
		if err := runTask("ansible:apply"); err != nil {
			logger.Warn("Ansible configuration failed")
			logger.Info("Run manually: task ansible:apply (task ansible:dry-run previews it)")
		} else {
			logger.OK("Proxmox configured via Ansible")
		}
	} else {
		logger.Warn("Skipped Ansible configuration")
		logger.Info("Run manually: task ansible:apply")
	}
	fmt.Println()

	logger.Info("Phase 3: Infrastructure provisioning (Terragrunt: task tf:apply ENV=homelab)")
	logger.Info("  Talos VMs, the control plane VIP, TrueNAS and the bootstrap Application; secrets via op run.")
	logger.Info("  See " + docProvisioning + " and " + docControlPlaneStorage + " (control plane disks)")
	if utils.Confirm("Run Terragrunt to provision the infrastructure?") {
		if err := runTask("tf:apply", "ENV=homelab"); err != nil {
			logger.Warn("Terragrunt provisioning failed")
			logger.Info("Run manually: task tf:apply ENV=homelab (task tf:plan ENV=homelab previews it)")
		} else {
			logger.OK("Infrastructure provisioned via Terragrunt")
		}
	} else {
		logger.Warn("Skipped Terragrunt provisioning")
		logger.Info("Run manually: task tf:apply ENV=homelab")
	}
	fmt.Println()

	logger.Info("Phase 4: GitOps")
	logger.Info("  The root Application applied by Terragrunt lets ArgoCD sync bootstrap -> addons -> applications.")
	logger.Info("  Watch it: task prod:status; verify: task verify:prod")
	fmt.Println()

	retrieveArgoCDPassword(opts)

	return nil
}

func retrieveArgoCDPassword(opts prereq.Options) {
	logger.Info("Retrieving ArgoCD admin password...")
	result, err := utils.ExecCommand("kubectl", "-n", "argocd", "get", "secret", "argocd-initial-admin-secret", "-o", "jsonpath={.data.password}")
	if err != nil || !result.Success || result.Stdout == "" {
		logger.Warn("Could not retrieve ArgoCD password (may not be deployed yet); later: task k8s:argocd-password")
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
	if rc, err := prereq.LoadHomelabConfig(opts); err == nil {
		if host := rc.Values["ARGOCD_HOSTNAME"].Value; host != "" {
			logger.Info("Access ArgoCD at: https://" + host)
		}
	}
	logger.Info("Username: admin")
	fmt.Println()
}

func printNextSteps(tier prereq.Tier) {
	fmt.Println()
	logger.Info("Next steps:")
	if tier == prereq.Localdev {
		fmt.Println("  1. Open the ArgoCD UI (task localdev:ui on macOS) and watch the Applications")
		fmt.Println("  2. Edit charts/ or configuration/, then task localdev:sync to push the working tree")
		fmt.Println("  3. task verify LEVEL=2 judges every Application and runs the e2e suite")
		fmt.Println()
		fmt.Println("Useful commands:")
		fmt.Println("  task localdev:report    - Markdown report of the loop (Application table, diffs)")
		fmt.Println("  task localdev:diagnose  - Conditions, events and pod logs of unhealthy Applications")
		fmt.Println("  task localdev:down      - Delete the Kind cluster")
	} else {
		fmt.Println("  1. Verify cluster health: kubectl get nodes")
		fmt.Println("  2. Check ArgoCD applications: kubectl get applications -n argocd")
		fmt.Println("  3. Monitor pod deployments: kubectl get pods -A")
		fmt.Println("  4. Access ArgoCD UI to see GitOps status")
		fmt.Println()
		fmt.Println("Useful commands:")
		fmt.Println("  task k8s:status          - Show cluster status")
		fmt.Println("  task k8s:argocd-password - Get ArgoCD admin password")
		fmt.Println("  task prod:status         - Read-only ArgoCD Application table")
	}
	fmt.Println()
}
