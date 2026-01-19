# Homelab Root Tiltfile
# Phase 0.5: Local Development Environment
#
# This is the root Tiltfile that includes the local development environment.
# It provides a simple entrypoint for starting the Tilt development environment
# from the repository root.
#
# Usage from repository root:
#   tilt up                    # Start local dev environment in direct mode
#   tilt up -- --mode=argocd   # Start local dev environment in ArgoCD mode
#   tilt down                  # Tear down all resources
#
# The actual Tilt configuration is in localdev/Tiltfile

# ============================================================================
# Banner
# ============================================================================

print("""
╔══════════════════════════════════════════════════════════════════════════╗
║                                                                          ║
║                        Homelab Development Environment                   ║
║                                                                          ║
║  This homelab needs no watering, no tending,                            ║
║  so I can tend to what actually grows.                                  ║
║                                                                          ║
╚══════════════════════════════════════════════════════════════════════════╝
""")

# ============================================================================
# Include Local Development Environment
# ============================================================================

# Include the localdev Tiltfile which contains all the actual configuration
# This allows running `tilt up` from the repository root
include('./localdev/Tiltfile')

# ============================================================================
# Root-level Resources
# ============================================================================

# Welcome message with helpful information
local_resource(
    "welcome",
    cmd="""
    echo ""
    echo "╔══════════════════════════════════════════════════════════════════════════╗"
    echo "║ Welcome to Homelab Local Development!                                   ║"
    echo "╚══════════════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Your local Kubernetes development environment is starting..."
    echo ""
    echo "📚 Quick Start Guide:"
    echo "  • Wait for all resources to turn green in the Tilt UI"
    echo "  • Access services via the URLs shown in the 'dev-info' resource"
    echo "  • Make changes to charts/ - they'll auto-deploy"
    echo "  • Press 'Space' in terminal for Tilt web UI or visit http://localhost:10350"
    echo ""
    echo "💡 Tips:"
    echo "  • Resources are organized by labels (infrastructure, addons, applications)"
    echo "  • Use 'tilt trigger <resource>' to manually trigger a resource"
    echo "  • Use 'tilt enable <resource>' to enable disabled resources"
    echo "  • Check the logs tab for any errors or warnings"
    echo ""
    echo "📖 Documentation:"
    echo "  • Local dev setup: docs/local-development.md"
    echo "  • Architecture:    docs/architecture.md"
    echo "  • Plan:            plan.md"
    echo ""
    """,
    labels=["welcome"],
    auto_init=True,
    trigger_mode=TRIGGER_MODE_MANUAL,
)

# ============================================================================
# Configuration Watchers
# ============================================================================

# Watch for changes to key configuration files
# This ensures Tilt reloads when important configs change
watch_file('./localdev/kind-config.yaml')
watch_file('./localdev/Tiltfile')
watch_file('./Tiltfile')

# ============================================================================
# Development Commands
# ============================================================================

# Quick reference for common kubectl commands
local_resource(
    "kubectl-cheatsheet",
    cmd="""
    echo ""
    echo "╔══════════════════════════════════════════════════════════════════════════╗"
    echo "║ kubectl Cheatsheet                                                       ║"
    echo "╚══════════════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "View Resources:"
    echo "  kubectl get pods --all-namespaces           # All pods"
    echo "  kubectl get svc --all-namespaces            # All services"
    echo "  kubectl get pvc --all-namespaces            # Persistent volumes"
    echo ""
    echo "Troubleshooting:"
    echo "  kubectl describe pod <name> -n <namespace>  # Pod details"
    echo "  kubectl logs <pod> -n <namespace>           # Pod logs"
    echo "  kubectl logs -f <pod> -n <namespace>        # Follow logs"
    echo "  kubectl get events --all-namespaces         # Cluster events"
    echo ""
    echo "Port Forwarding:"
    echo "  kubectl port-forward -n <ns> svc/<name> <local>:<remote>"
    echo ""
    echo "Quick Debug:"
    echo "  kubectl run -it --rm debug --image=busybox --restart=Never -- sh"
    echo ""
    """,
    labels=["utils"],
    auto_init=False,
    trigger_mode=TRIGGER_MODE_MANUAL,
)

# Resource cleanup helper
local_resource(
    "cleanup-all",
    cmd="""
    echo "Cleaning up stuck resources..."
    kubectl delete pods --field-selector=status.phase=Failed --all-namespaces
    kubectl delete pods --field-selector=status.phase=Unknown --all-namespaces
    echo "Cleanup complete!"
    """,
    labels=["utils"],
    auto_init=False,
    trigger_mode=TRIGGER_MODE_MANUAL,
)

# ============================================================================
# Context Information
# ============================================================================

# Display current cluster context
local_resource(
    "cluster-context",
    cmd="""
    echo "Current Kubernetes Context:"
    kubectl config current-context
    echo ""
    echo "Cluster Info:"
    kubectl cluster-info
    """,
    labels=["info"],
    auto_init=True,
    trigger_mode=TRIGGER_MODE_MANUAL,
)

# ============================================================================
# Notes
# ============================================================================

# This root Tiltfile serves as:
# 1. Entry point for developers (can run `tilt up` from repo root)
# 2. Welcome message and orientation for new developers
# 3. Quick reference for common commands
# 4. Central place to add repo-wide Tilt configuration
#
# The actual environment setup is delegated to localdev/Tiltfile
# to keep concerns separated and maintain the ability to run
# `tilt up` from either location.
