package commands

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

// Rendered file mappings: 1Password document title -> local file path
var renderedFiles = map[string]string{
	"helm-rendered-cilium":               "terragrunt/files/cilium-rendered.yaml",
	"helm-rendered-kubelet-csr-approver": "terragrunt/files/kubelet-csr-approver-rendered.yaml",
	"helm-rendered-spegel":               "terragrunt/files/spegel-rendered.yaml",
}

const onePasswordVault = "homelab"

// NewRenderCmd creates the render command with subcommands
func NewRenderCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "render",
		Short: "Manage rendered Helm manifests in 1Password",
		Long:  `Push, pull, and sync rendered Helm manifest files to/from 1Password Documents for cross-machine consistency.`,
	}

	cmd.AddCommand(newRenderPushCmd())
	cmd.AddCommand(newRenderPullCmd())
	cmd.AddCommand(newRenderStatusCmd())
	cmd.AddCommand(newRenderSyncCmd())

	return cmd
}

func newRenderPushCmd() *cobra.Command {
	var force, quiet bool

	cmd := &cobra.Command{
		Use:   "push",
		Short: "Upload rendered YAML files to 1Password",
		Long:  `Upload local rendered Helm manifest files to 1Password Documents for cross-machine sharing.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			if !quiet {
				logger.Info("=== Push Rendered Files to 1Password ===")
				fmt.Println()
			}

			projectRoot, err := findProjectRoot()
			if err != nil {
				return err
			}

			if err := check1PasswordAuth(); err != nil {
				logger.Error("1Password CLI not authenticated. Run: eval $(op signin)")
				return err
			}

			pushedCount := 0
			skippedCount := 0

			for docTitle, relPath := range renderedFiles {
				localPath := filepath.Join(projectRoot, relPath)

				// Check if local file exists
				if _, err := os.Stat(localPath); os.IsNotExist(err) {
					if !quiet {
						logger.Warn(fmt.Sprintf("Local file not found: %s", relPath))
					}
					skippedCount++
					continue
				}

				// Check if document exists in 1Password
				exists, err := documentExists(docTitle)
				if err != nil {
					return fmt.Errorf("failed to check document existence: %w", err)
				}

				if exists && !force {
					if !quiet {
						logger.Info(fmt.Sprintf("Document '%s' already exists (use --force to overwrite)", docTitle))
					}
					skippedCount++
					continue
				}

				// Delete existing document if force is enabled
				if exists && force {
					if DryRun {
						logger.Warn(fmt.Sprintf("Would delete existing document: %s", docTitle))
					} else {
						if err := deleteDocument(docTitle); err != nil {
							return fmt.Errorf("failed to delete existing document: %w", err)
						}
					}
				}

				// Upload document
				if DryRun {
					logger.Warn(fmt.Sprintf("Would upload: %s -> %s", relPath, docTitle))
				} else {
					if err := uploadDocument(localPath, docTitle); err != nil {
						return fmt.Errorf("failed to upload %s: %w", relPath, err)
					}
					if !quiet {
						logger.OK(fmt.Sprintf("Uploaded: %s -> %s", relPath, docTitle))
					}
				}
				pushedCount++
			}

			if !quiet {
				fmt.Println()
				logger.Info(fmt.Sprintf("Pushed: %d, Skipped: %d", pushedCount, skippedCount))
			}

			return nil
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Overwrite existing documents in 1Password")
	cmd.Flags().BoolVar(&quiet, "quiet", false, "Suppress output (for automated workflows)")

	return cmd
}

func newRenderPullCmd() *cobra.Command {
	var force, quiet bool

	cmd := &cobra.Command{
		Use:   "pull",
		Short: "Download rendered YAML files from 1Password",
		Long:  `Download rendered Helm manifest files from 1Password Documents to local filesystem.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			if !quiet {
				logger.Info("=== Pull Rendered Files from 1Password ===")
				fmt.Println()
			}

			projectRoot, err := findProjectRoot()
			if err != nil {
				return err
			}

			if err := check1PasswordAuth(); err != nil {
				logger.Error("1Password CLI not authenticated. Run: eval $(op signin)")
				return err
			}

			pulledCount := 0
			skippedCount := 0

			for docTitle, relPath := range renderedFiles {
				localPath := filepath.Join(projectRoot, relPath)

				// Check if document exists in 1Password
				exists, err := documentExists(docTitle)
				if err != nil {
					return fmt.Errorf("failed to check document existence: %w", err)
				}

				if !exists {
					if !quiet {
						logger.Warn(fmt.Sprintf("Document not found in 1Password: %s", docTitle))
					}
					skippedCount++
					continue
				}

				// Check if local file exists and skip if not forcing
				if _, err := os.Stat(localPath); err == nil && !force {
					if !quiet {
						logger.Info(fmt.Sprintf("Local file exists: %s (use --force to overwrite)", relPath))
					}
					skippedCount++
					continue
				}

				// Download document
				if DryRun {
					logger.Warn(fmt.Sprintf("Would download: %s -> %s", docTitle, relPath))
				} else {
					// Ensure directory exists
					if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
						return fmt.Errorf("failed to create directory: %w", err)
					}

					if err := downloadDocument(docTitle, localPath); err != nil {
						return fmt.Errorf("failed to download %s: %w", docTitle, err)
					}
					if !quiet {
						logger.OK(fmt.Sprintf("Downloaded: %s -> %s", docTitle, relPath))
					}
				}
				pulledCount++
			}

			if !quiet {
				fmt.Println()
				logger.Info(fmt.Sprintf("Pulled: %d, Skipped: %d", pulledCount, skippedCount))
			}

			return nil
		},
	}

	cmd.Flags().BoolVar(&force, "force", false, "Overwrite existing local files")
	cmd.Flags().BoolVar(&quiet, "quiet", false, "Suppress output (for automated workflows)")

	return cmd
}

func newRenderStatusCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Compare local files vs 1Password documents",
		Long:  `Show the status of rendered files: whether they exist locally, in 1Password, and if they match.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			logger.Info("=== Rendered Files Status ===")
			fmt.Println()

			projectRoot, err := findProjectRoot()
			if err != nil {
				return err
			}

			if err := check1PasswordAuth(); err != nil {
				logger.Error("1Password CLI not authenticated. Run: eval $(op signin)")
				return err
			}

			for docTitle, relPath := range renderedFiles {
				localPath := filepath.Join(projectRoot, relPath)

				// Check local file
				localExists := false
				var localHash string
				if _, err := os.Stat(localPath); err == nil {
					localExists = true
					localHash, _ = fileHash(localPath)
				}

				// Check 1Password document
				remoteExists, err := documentExists(docTitle)
				if err != nil {
					return fmt.Errorf("failed to check document: %w", err)
				}

				var remoteHash string
				if remoteExists {
					// Download to temp file to calculate hash
					tmpFile, err := os.CreateTemp("", "render-status-*")
					if err != nil {
						return fmt.Errorf("failed to create temp file: %w", err)
					}
					tmpPath := tmpFile.Name()
					tmpFile.Close()
					defer os.Remove(tmpPath)

					if err := downloadDocument(docTitle, tmpPath); err != nil {
						return fmt.Errorf("failed to download for comparison: %w", err)
					}
					remoteHash, _ = fileHash(tmpPath)
				}

				// Determine status
				var status string
				if localExists && remoteExists {
					if localHash == remoteHash {
						status = "OK (synced)"
						logger.OK(fmt.Sprintf("%s: %s", docTitle, status))
					} else {
						status = "DIFFERS (local and remote differ)"
						logger.Warn(fmt.Sprintf("%s: %s", docTitle, status))
					}
				} else if localExists && !remoteExists {
					status = "LOCAL ONLY (push to sync)"
					logger.Warn(fmt.Sprintf("%s: %s", docTitle, status))
				} else if !localExists && remoteExists {
					status = "REMOTE ONLY (pull to sync)"
					logger.Warn(fmt.Sprintf("%s: %s", docTitle, status))
				} else {
					status = "MISSING (run 'task render' first)"
					logger.Error(fmt.Sprintf("%s: %s", docTitle, status))
				}
			}

			return nil
		},
	}

	return cmd
}

func newRenderSyncCmd() *cobra.Command {
	var quiet bool

	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Sync rendered files between local and 1Password",
		Long: `Smart sync:
- If file exists only locally: push to 1Password
- If file exists only in 1Password: pull to local
- If both exist and match: do nothing
- If both exist and differ: warn (manual resolution needed)`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			if !quiet {
				logger.Info("=== Sync Rendered Files ===")
				fmt.Println()
			}

			projectRoot, err := findProjectRoot()
			if err != nil {
				return err
			}

			if err := check1PasswordAuth(); err != nil {
				logger.Error("1Password CLI not authenticated. Run: eval $(op signin)")
				return err
			}

			pushedCount := 0
			pulledCount := 0
			syncedCount := 0
			conflictCount := 0

			for docTitle, relPath := range renderedFiles {
				localPath := filepath.Join(projectRoot, relPath)

				// Check local file
				localExists := false
				var localHash string
				if _, err := os.Stat(localPath); err == nil {
					localExists = true
					localHash, _ = fileHash(localPath)
				}

				// Check 1Password document
				remoteExists, err := documentExists(docTitle)
				if err != nil {
					return fmt.Errorf("failed to check document: %w", err)
				}

				var remoteHash string
				var tmpPath string
				if remoteExists {
					tmpFile, err := os.CreateTemp("", "render-sync-*")
					if err != nil {
						return fmt.Errorf("failed to create temp file: %w", err)
					}
					tmpPath = tmpFile.Name()
					tmpFile.Close()
					defer os.Remove(tmpPath)

					if err := downloadDocument(docTitle, tmpPath); err != nil {
						return fmt.Errorf("failed to download for comparison: %w", err)
					}
					remoteHash, _ = fileHash(tmpPath)
				}

				if localExists && remoteExists {
					if localHash == remoteHash {
						if !quiet {
							logger.OK(fmt.Sprintf("%s: already synced", docTitle))
						}
						syncedCount++
					} else {
						logger.Warn(fmt.Sprintf("%s: CONFLICT - local and remote differ", docTitle))
						logger.Warn("  Use 'render push --force' or 'render pull --force' to resolve")
						conflictCount++
					}
				} else if localExists && !remoteExists {
					// Push to 1Password
					if DryRun {
						logger.Warn(fmt.Sprintf("Would push: %s", docTitle))
					} else {
						if err := uploadDocument(localPath, docTitle); err != nil {
							return fmt.Errorf("failed to upload %s: %w", relPath, err)
						}
						if !quiet {
							logger.OK(fmt.Sprintf("Pushed: %s", docTitle))
						}
					}
					pushedCount++
				} else if !localExists && remoteExists {
					// Pull from 1Password
					if DryRun {
						logger.Warn(fmt.Sprintf("Would pull: %s", docTitle))
					} else {
						// Ensure directory exists
						if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
							return fmt.Errorf("failed to create directory: %w", err)
						}

						// Copy from temp file to local path
						content, err := os.ReadFile(tmpPath)
						if err != nil {
							return fmt.Errorf("failed to read temp file: %w", err)
						}
						if err := os.WriteFile(localPath, content, 0644); err != nil {
							return fmt.Errorf("failed to write local file: %w", err)
						}
						if !quiet {
							logger.OK(fmt.Sprintf("Pulled: %s", docTitle))
						}
					}
					pulledCount++
				} else {
					if !quiet {
						logger.Warn(fmt.Sprintf("%s: missing (run 'task render' first)", docTitle))
					}
				}
			}

			if !quiet {
				fmt.Println()
				logger.Info(fmt.Sprintf("Synced: %d, Pushed: %d, Pulled: %d, Conflicts: %d", syncedCount, pushedCount, pulledCount, conflictCount))
			}

			if conflictCount > 0 {
				return fmt.Errorf("%d conflicts detected - manual resolution required", conflictCount)
			}

			return nil
		},
	}

	cmd.Flags().BoolVar(&quiet, "quiet", false, "Suppress output (for automated workflows)")

	return cmd
}

// findProjectRoot finds the project root by looking for Taskfile.yml
func findProjectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "Taskfile.yml")); err == nil {
			return dir, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find project root (no Taskfile.yml found)")
		}
		dir = parent
	}
}

// documentExists checks if a document exists in 1Password
func documentExists(title string) (bool, error) {
	result, err := utils.ExecCommand("op", "document", "get", title, "--vault", onePasswordVault)
	if err != nil {
		// Check if the error is "document not found"
		if strings.Contains(result.Stderr, "isn't a document") ||
			strings.Contains(result.Stderr, "not found") ||
			strings.Contains(result.Stderr, "doesn't seem to be a document") ||
			result.Code == 1 {
			return false, nil
		}
		return false, err
	}
	return result.Success, nil
}

// uploadDocument uploads a file to 1Password as a document
func uploadDocument(localPath, title string) error {
	result, err := utils.ExecCommand("op", "document", "create", localPath,
		"--title", title,
		"--vault", onePasswordVault)
	if err != nil {
		return fmt.Errorf("op document create failed: %s", result.Stderr)
	}
	return nil
}

// downloadDocument downloads a document from 1Password
func downloadDocument(title, localPath string) error {
	result, err := utils.ExecCommand("op", "document", "get", title,
		"--vault", onePasswordVault,
		"--out-file", localPath,
		"--force")
	if err != nil {
		return fmt.Errorf("op document get failed: %s", result.Stderr)
	}
	return nil
}

// deleteDocument deletes a document from 1Password
func deleteDocument(title string) error {
	result, err := utils.ExecCommand("op", "document", "delete", title,
		"--vault", onePasswordVault)
	if err != nil {
		return fmt.Errorf("op document delete failed: %s", result.Stderr)
	}
	return nil
}

// fileHash calculates SHA256 hash of a file
func fileHash(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:]), nil
}
