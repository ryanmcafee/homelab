#!/usr/bin/env bash
# Main setup script for homelab infrastructure

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "======================================"
echo "  Homelab Infrastructure Setup"
echo "======================================"
echo ""

# Function to print step
print_step() {
    echo -e "${BLUE}==>${NC} $1"
}

# Function to print success
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

# Function to print warning
print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Function to print error
print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Function to confirm action
confirm() {
    read -r -p "${1:-Are you sure?} [y/N] " response
    case "$response" in
        [yY][eE][sS]|[yY])
            true
            ;;
        *)
            false
            ;;
    esac
}

# Function to install mise if not present
install_mise() {
    if command -v mise &> /dev/null; then
        print_success "mise is already installed ($(mise --version))"
        return 0
    fi

    print_step "mise not found - installing..."

    # Install mise using official installer
    if curl https://mise.run | sh; then
        print_success "mise installed successfully"

        # Activate mise for current session
        export PATH="$HOME/.local/bin:$PATH"
        eval "$(mise activate bash)"

        print_warning "mise activated for this session"
        echo "To make this permanent, add the following to your ~/.bashrc or ~/.zshrc:"
        echo '  eval "$(~/.local/bin/mise activate bash)"'
        echo ""
    else
        print_error "Failed to install mise"
        return 1
    fi
}

# Function to install all tools via mise
install_tools() {
    print_step "Installing all dependencies via mise..."
    cd "$PROJECT_ROOT"

    if mise install -y; then
        print_success "All tools installed via mise"
    else
        print_error "mise installation failed"
        echo "Run 'mise doctor' for diagnostics"
        return 1
    fi

    # Create Terraform plugin cache directory
    print_step "Setting up Terraform plugin cache..."
    mkdir -p "$PROJECT_ROOT/.terraform.d/plugin-cache"
    print_success "Terraform plugin cache directory created"

    # Fix ansible symlinks (workaround for pipx backend limitation)
    print_step "Setting up ansible binaries..."
    local ansible_bin_dir=$(find "$HOME/.local/share/mise/installs/pipx-ansible" -maxdepth 2 -type d -name bin 2>/dev/null | head -1)
    if [ -n "$ansible_bin_dir" ] && [ -d "$ansible_bin_dir/../ansible/bin" ]; then
        cd "$ansible_bin_dir"
        for binary in ansible ansible-playbook ansible-galaxy ansible-vault ansible-config ansible-console ansible-doc ansible-inventory ansible-pull ansible-test; do
            if [ ! -e "$binary" ]; then
                ln -sf "../ansible/bin/$binary" "$binary"
            fi
        done
        cd "$PROJECT_ROOT"
        print_success "Ansible binaries configured"
    else
        print_warning "Could not configure ansible binaries (may already be configured)"
    fi
}

# Step 0: Ensure mise is installed and install all tools
print_step "Checking for mise..."
if ! install_mise; then
    print_error "mise installation failed"
    exit 1
fi
echo ""

print_step "Installing tools via mise..."
if ! install_tools; then
    print_error "Tool installation failed"
    exit 1
fi
echo ""

# Step 1: Validate prerequisites
print_step "Validating prerequisites..."
if ! "$SCRIPT_DIR/validate-prerequisites.sh"; then
    print_error "Prerequisites validation failed"
    echo ""
    echo "Please check that all tools are installed correctly."
    echo "Run: mise doctor"
    exit 1
fi
print_success "Prerequisites validated"
echo ""

# Step 2: Check environment
print_step "Checking environment configuration..."

if [ -z "${TF_VAR_proxmox_api_url:-}" ]; then
    print_warning "Environment variables not set"
    echo "Please copy .envrc.example to .envrc and fill in your values"
    echo "Then run: direnv allow"

    if ! confirm "Continue without environment variables?"; then
        exit 1
    fi
fi
print_success "Environment checked"
echo ""

# Step 3: Determine deployment target
echo "Select deployment target:"
echo "  1) localdev  - Local Kind cluster (no hardware required)"
echo "  2) dev       - Development environment (Proxmox)"
echo "  3) prod      - Production environment (Proxmox)"
echo ""
read -r -p "Enter choice [1-3]: " choice

case $choice in
    1)
        ENVIRONMENT="localdev"
        print_step "Setting up local development environment..."
        ;;
    2)
        ENVIRONMENT="dev"
        print_step "Setting up development environment..."
        ;;
    3)
        ENVIRONMENT="prod"
        print_step "Setting up production environment..."
        if ! confirm "Deploy to PRODUCTION?"; then
            exit 1
        fi
        ;;
    *)
        print_error "Invalid choice"
        exit 1
        ;;
esac
echo ""

# Step 4: Execute deployment based on environment
case $ENVIRONMENT in
    localdev)
        print_step "Creating Kind cluster..."
        cd "$PROJECT_ROOT"
        task localdev:kind
        print_success "Kind cluster created"
        echo ""

        print_step "Starting Tilt..."
        echo "Tilt will start in the background"
        echo "Access Tilt UI at: http://localhost:10350"
        echo ""
        echo "Services will be available at:"
        echo "  - ArgoCD:  http://localhost:8080"
        echo "  - Traefik: http://localhost:9080"
        echo "  - Grafana: http://localhost:3000"
        echo ""

        if confirm "Start Tilt now?"; then
            cd localdev
            tilt up
        else
            echo "Run 'task localdev:tilt' to start Tilt later"
        fi
        ;;

    dev|prod)
        print_step "Phase 1: Proxmox Installation"
        echo "This phase must be completed manually."
        echo "See plan.md Phase 1 for detailed instructions."
        echo ""

        if ! confirm "Has Proxmox been installed and is accessible?"; then
            print_warning "Please install Proxmox first"
            exit 1
        fi
        print_success "Proxmox installation confirmed"
        echo ""

        print_step "Phase 2: Proxmox Configuration (Ansible)"
        if confirm "Run Ansible playbooks to configure Proxmox?"; then
            cd "$PROJECT_ROOT/ansible"
            ansible-playbook playbooks/site.yml
            print_success "Proxmox configured via Ansible"
        else
            print_warning "Skipped Ansible configuration"
            echo "Run manually: task ansible:apply"
        fi
        echo ""

        print_step "Phase 3: Infrastructure Provisioning (Terragrunt)"
        if confirm "Run Terragrunt to provision infrastructure?"; then
            cd "$PROJECT_ROOT/terragrunt/environments/$ENVIRONMENT"
            terragrunt run-all apply
            print_success "Infrastructure provisioned via Terragrunt"
        else
            print_warning "Skipped Terragrunt provisioning"
            echo "Run manually: task tf:apply ENV=$ENVIRONMENT"
        fi
        echo ""

        print_step "Phase 4: GitOps Bootstrap"
        echo "ArgoCD should now be deployed and managing the cluster"
        echo ""

        print_step "Retrieving ArgoCD admin password..."
        if command -v kubectl &> /dev/null; then
            ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || echo "")
            if [ -n "$ARGOCD_PASSWORD" ]; then
                echo "ArgoCD admin password: $ARGOCD_PASSWORD"
                echo ""
                echo "Access ArgoCD at: https://argocd.ryanmcafee.com"
                echo "Username: admin"
            else
                print_warning "Could not retrieve ArgoCD password (may not be deployed yet)"
            fi
        fi
        ;;
esac

echo ""
echo "======================================"
print_success "Setup complete!"
echo "======================================"
echo ""

# Print next steps
echo "Next steps:"
case $ENVIRONMENT in
    localdev)
        echo "  1. Check Tilt UI for deployment status"
        echo "  2. Access ArgoCD to see GitOps in action"
        echo "  3. Make changes to charts/ and see live updates"
        echo ""
        echo "Useful commands:"
        echo "  task localdev:logs    - Stream logs from all pods"
        echo "  task localdev:down    - Tear down environment"
        echo "  task chart:lint       - Lint Helm charts"
        ;;
    dev|prod)
        echo "  1. Verify cluster health: kubectl get nodes"
        echo "  2. Check ArgoCD applications: kubectl get applications -n argocd"
        echo "  3. Monitor pod deployments: kubectl get pods -A"
        echo "  4. Access ArgoCD UI to see GitOps status"
        echo ""
        echo "Useful commands:"
        echo "  task k8s:status       - Show cluster status"
        echo "  task k8s:argocd-password - Get ArgoCD admin password"
        ;;
esac
echo ""
