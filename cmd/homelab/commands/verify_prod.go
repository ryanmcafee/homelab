package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/verify"
	"github.com/spf13/cobra"
)

// prodRunner executes kubectl for `verify prod`; tests replace it with a fake.
var prodRunner verify.Runner = verify.ExecRunner{}

// defaultProdKubeconfig is where `task prod:kubeconfig` writes the read-only
// kubeconfig. A separate file keeps the admin kubeconfig out of the picture.
func defaultProdKubeconfig() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".kube", "homelab-readonly.yaml")
}

// newVerifyProdCmd reads the production ArgoCD Applications through the
// read-only agent identity (docs/runbooks/readonly-access.md). It only ever
// runs `kubectl get`; nothing it does can change the cluster (ADR-009).
func newVerifyProdCmd() *cobra.Command {
	var (
		kubeContext    string
		kubeconfig     string
		requestTimeout string
		asJSON         bool
		requireSynced  bool
	)

	cmd := &cobra.Command{
		Use:   "prod",
		Short: "Read-only ArgoCD Application health of the homelab cluster (prod/argocd/<app>, level-2 JSON contract)",
		Long: `Read every ArgoCD Application in the homelab (production) cluster and report
one check per Application, prod/argocd/<app>: pass when it is Healthy and its
last sync operation Succeeded (--require-synced also demands Synced).

The read goes through the homelab-readonly context that task prod:kubeconfig
writes into ~/.kube/homelab-readonly.yaml: the agent-readonly ServiceAccount
(charts/agent-readonly: view + homelab-agent-readonly, no Secrets, no write
verbs) reached through the Tailscale operator's API server proxy. The command
runs a single kubectl get and never mutates anything; changes to production
happen only through merge -> ArgoCD (ADR-009).

Kind contexts (kind-*) are refused: the local loop is verified with
homelab verify all --level 2. Anything that prevents the read (no kubeconfig,
Tailscale down, token revoked, RBAC missing) is one failing prod/argocd/apps
check, never a skip. Setup: docs/runbooks/readonly-access.md.

Exit code 0 when every Application passes, 1 when any check fails, 2 on usage error.`,
		Args:          UsageArgs(cobra.NoArgs),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctxName := strings.TrimSpace(kubeContext)
			if ctxName == "" {
				return usageErrorf("--kube-context is required (the read-only context is %s)", verify.ProdKubeContext)
			}
			if strings.HasPrefix(ctxName, "kind-") {
				return usageErrorf("--kube-context %q is a Kind cluster; verify the local loop with `homelab verify all --level 2` (verify prod reads production only)", ctxName)
			}
			if d, err := time.ParseDuration(requestTimeout); err != nil || d <= 0 {
				return usageErrorf("--request-timeout must be a positive duration such as 30s, got %q", requestTimeout)
			}
			dir, err := os.Getwd()
			if err != nil {
				return err
			}

			start := time.Now()
			result := verify.NewResult(levelLive)
			result.Add(verify.ProdArgoCDApps(cmd.Context(), verify.ProdOptions{
				Runner:         prodRunner,
				Dir:            dir,
				Kubeconfig:     strings.TrimSpace(kubeconfig),
				KubeContext:    ctxName,
				RequestTimeout: requestTimeout,
				RequireSynced:  requireSynced,
			})...)
			result.Finalize(start)

			out := cmd.OutOrStdout()
			if asJSON {
				b, err := result.JSON()
				if err != nil {
					return err
				}
				fmt.Fprintln(out, string(b))
			} else {
				result.WriteText(out)
			}
			if !result.Pass {
				return ErrVerificationFailed
			}
			return nil
		},
	}

	cmd.Flags().StringVar(&kubeContext, "kube-context", verify.ProdKubeContext, "Read-only kubeconfig context of the homelab cluster (kind-* contexts are refused)")
	cmd.Flags().StringVar(&kubeconfig, "kubeconfig", defaultProdKubeconfig(), "Kubeconfig file holding the read-only context (written by task prod:kubeconfig); empty uses kubectl's default resolution")
	cmd.Flags().StringVar(&requestTimeout, "request-timeout", "30s", "kubectl --request-timeout for the read")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the machine-readable result contract")
	cmd.Flags().BoolVar(&requireSynced, "require-synced", false, "Also fail Applications whose sync status is not Synced")
	return cmd
}
