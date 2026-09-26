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
			var skipped []string
			switch tier {
			case prereq.Localdev:
				skipped, err = deployLocaldev()
			case prereq.Homelab:
				skipped, err = deployHomelab(opts)
			}
			if err != nil {
				return err
			}

			printCompletion(skipped)
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

// phase is one step of a tier's bring-up.
//
// component is the name reported when the phase fails, so the last line an
// operator reads names the part of the platform to go and fix rather than the
// step number that gave up.
//
// confirm, when non-empty, asks before running. Declining an optional phase
// skips it, which is a legitimate choice — the operator may have run it by
// hand already. Declining one marked confirmRequired aborts, because the
// phases after it cannot mean anything without it.
type phase struct {
	name            string
	component       string
	detail          []string
	confirm         string
	confirmRequired bool
	run             func() error
	// fixHint is the command to run by hand after this phase is skipped or
	// fails. Every phase that can be skipped or can fail must set one, so no
	// path out of bootstrap leaves the operator without a next command.
	fixHint string
}

// confirmFn is utils.Confirm behind a seam so the phase runner can be tested
// without a terminal.
var confirmFn = utils.Confirm

// runPhases executes phases in order and stops at the first failure, returning
// the components the operator chose to skip.
//
// Stopping is the point. Before this, a failing `task tf:apply` logged a
// warning, fell through to the next phase and ended on "Setup complete!" — so
// a fork whose infrastructure never provisioned was told it had succeeded.
// A phase that fails now aborts the bring-up and names its component.
func runPhases(phases []phase) ([]string, error) {
	var skipped []string

	for i, p := range phases {
		logger.Info(fmt.Sprintf("Phase %d/%d: %s (%s)", i+1, len(phases), p.name, p.component))
		for _, line := range p.detail {
			logger.Info("  " + line)
		}

		// --dry-run walks every phase to print the resolved order. It must not
		// prompt: utils.Confirm answers no under DryRun, which would abort the
		// walk at the first gate and print nothing about the phases behind it.
		// runTask and utils.ExecCommand already no-op under DryRun, so nothing
		// here mutates.
		if p.confirm != "" && !DryRun && !confirmFn(p.confirm) {
			if p.confirmRequired {
				logger.Error(fmt.Sprintf("Phase %d/%d cannot be skipped: %s", i+1, len(phases), p.component))
				if p.fixHint != "" {
					logger.Info("  " + p.fixHint)
				}
				return skipped, fmt.Errorf("%s: declined by operator", p.component)
			}
			logger.Warn(fmt.Sprintf("Skipped %s", p.component))
			if p.fixHint != "" {
				logger.Info("  Run it later: " + p.fixHint)
			}
			skipped = append(skipped, p.component)
			fmt.Println()
			continue
		}

		if p.run != nil {
			if err := p.run(); err != nil {
				logger.Error(fmt.Sprintf("Phase %d/%d failed: %s", i+1, len(phases), p.component))
				if p.fixHint != "" {
					logger.Info("  Retry with: " + p.fixHint)
				}
				return skipped, fmt.Errorf("%s: %w", p.component, err)
			}
		}

		logger.OK(p.name)
		fmt.Println()
	}

	return skipped, nil
}

// printCompletion reports the outcome honestly: "complete" only when every
// phase actually ran.
func printCompletion(skipped []string) {
	if len(skipped) == 0 {
		logger.OK("Setup complete!")
		return
	}
	logger.Warn(fmt.Sprintf("Setup finished with %d phase(s) skipped: %s", len(skipped), strings.Join(skipped, ", ")))
	logger.Info("The cluster is not fully bootstrapped until those run; each printed its command above.")
}

// deployLocaldev runs the Kind + ArgoCD loop through the Taskfile and waits
// until every Application is Healthy.
func deployLocaldev() ([]string, error) {
	skipped, err := runPhases([]phase{
		{
			name:      "Kind + ArgoCD loop",
			component: "localdev:up",
			detail: []string{
				"Kind (Cilium, registry caches, fakes) -> ArgoCD -> every Application synced from the working tree",
				"See " + docLocalDevelopment,
			},
			run:     func() error { return runTask("localdev:up") },
			fixHint: "task localdev:diagnose to inspect; task localdev:up to retry",
		},
		{
			name:      "Wait for every Application to be Healthy",
			component: "argocd",
			run:       func() error { return runTask("localdev:wait") },
			fixHint:   "task localdev:diagnose; re-sync one app with task localdev:sync -- --only <app>",
		},
	})
	if err != nil {
		return skipped, err
	}

	printLocaldevAccess()
	return skipped, nil
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
func deployHomelab(opts prereq.Options) ([]string, error) {
	skipped, err := runPhases(homelabPhases())
	if err != nil {
		return skipped, err
	}

	retrieveArgoCDPassword(opts)

	return skipped, nil
}

// homelabPhases is the production bring-up order, kept separate from
// deployHomelab so the ordering and its recovery hints can be asserted without
// touching Proxmox.
func homelabPhases() []phase {
	return []phase{
		{
			name:      "Proxmox installation",
			component: "proxmox",
			detail: []string{
				"Proxmox VE is installed by hand on the host; the rest is automated from here.",
				"See " + docProvisioning,
			},
			confirm:         "Has Proxmox been installed and is it accessible?",
			confirmRequired: true,
			fixHint:         "Install Proxmox first, then rerun ./bin/homelab bootstrap -e homelab",
		},
		{
			name:      "Proxmox configuration",
			component: "ansible",
			detail: []string{
				"Runs ansible/playbooks/site.yml against the Proxmox host.",
				"See " + docProvisioning,
			},
			confirm: "Run Ansible to configure Proxmox?",
			run:     func() error { return runTask("ansible:apply") },
			fixHint: "task ansible:apply (task ansible:dry-run previews it)",
		},
		{
			name:      "Infrastructure provisioning",
			component: "terragrunt",
			detail: []string{
				"Talos VMs, the control plane VIP, TrueNAS and the bootstrap Application; secrets via op run.",
				"See " + docProvisioning + " and " + docControlPlaneStorage + " (control plane disks)",
			},
			confirm: "Run Terragrunt to provision the infrastructure?",
			run:     func() error { return runTask("tf:apply", "ENV=homelab") },
			fixHint: "task tf:apply ENV=homelab (task tf:plan ENV=homelab previews it)",
		},
		{
			name:      "GitOps handover",
			component: "argocd",
			detail: []string{
				"The root Application applied by Terragrunt lets ArgoCD sync bootstrap -> addons -> applications.",
				"Watch it: task prod:status; verify: task verify:prod",
			},
		},
	}
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
