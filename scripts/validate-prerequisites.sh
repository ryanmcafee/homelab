#!/usr/bin/env bash
# Validate prerequisites for homelab setup

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track overall status
MISSING_PREREQS=0

echo "=================================="
echo "Homelab Prerequisites Validation"
echo "=================================="
echo ""

# Function to check if command exists
check_command() {
    local cmd=$1
    local name=${2:-$cmd}
    local required=${3:-true}

    if command -v "$cmd" &> /dev/null; then
        local version=$($cmd --version 2>&1 | head -n1 || echo "unknown")
        echo -e "${GREEN}✓${NC} $name: $version"
        return 0
    else
        if [ "$required" = true ]; then
            echo -e "${RED}✗${NC} $name: NOT FOUND (required)"
            MISSING_PREREQS=$((MISSING_PREREQS + 1))
        else
            echo -e "${YELLOW}⚠${NC} $name: NOT FOUND (optional)"
        fi
        return 1
    fi
}

# Function to check environment variable
check_env_var() {
    local var=$1
    local name=${2:-$var}
    local required=${3:-false}

    if [ -n "${!var:-}" ]; then
        echo -e "${GREEN}✓${NC} $name: SET"
        return 0
    else
        if [ "$required" = true ]; then
            echo -e "${RED}✗${NC} $name: NOT SET (required)"
            MISSING_PREREQS=$((MISSING_PREREQS + 1))
        else
            echo -e "${YELLOW}⚠${NC} $name: NOT SET (optional)"
        fi
        return 1
    fi
}

echo "Core Tools:"
check_command "git" "Git"
check_command "curl" "curl"
check_command "wget" "wget"
check_command "jq" "jq" false

echo ""
echo "Infrastructure Tools:"
check_command "terraform" "Terraform" false
check_command "terragrunt" "Terragrunt" false
check_command "ansible" "Ansible" false
check_command "ansible-playbook" "Ansible Playbook" false

echo ""
echo "Kubernetes Tools:"
check_command "kubectl" "kubectl" false
check_command "kind" "Kind" false
check_command "tilt" "Tilt" false
check_command "helm" "Helm" false
check_command "talosctl" "talosctl" false

echo ""
echo "Development Tools:"
check_command "docker" "Docker" false
check_command "task" "Task (go-task)" false
check_command "direnv" "direnv" false

echo ""
echo "Secrets Management:"
check_command "op" "1Password CLI" false

echo ""
echo "Environment Variables:"
check_env_var "TF_VAR_proxmox_api_url" "Proxmox API URL" false
check_env_var "TF_VAR_proxmox_api_token_id" "Proxmox API Token ID" false
check_env_var "TF_VAR_proxmox_api_token_secret" "Proxmox API Token Secret" false
check_env_var "OP_CONNECT_HOST" "1Password Connect Host" false
check_env_var "OP_CONNECT_TOKEN" "1Password Connect Token" false

echo ""
echo "File System Checks:"
if [ -f ".envrc" ]; then
    echo -e "${GREEN}✓${NC} .envrc: EXISTS"
else
    echo -e "${YELLOW}⚠${NC} .envrc: NOT FOUND (copy from .envrc.example)"
fi

if [ -d ".git" ]; then
    echo -e "${GREEN}✓${NC} Git repository: INITIALIZED"
else
    echo -e "${RED}✗${NC} Git repository: NOT INITIALIZED"
    MISSING_PREREQS=$((MISSING_PREREQS + 1))
fi

echo ""
echo "=================================="

if [ $MISSING_PREREQS -eq 0 ]; then
    echo -e "${GREEN}All required prerequisites are satisfied!${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Review and update .envrc with your configuration"
    echo "  2. Run 'direnv allow' to load environment variables"
    echo "  3. For local development: task localdev:up"
    echo "  4. For production setup: ./scripts/setup.sh"
    exit 0
else
    echo -e "${RED}Missing $MISSING_PREREQS required prerequisite(s)${NC}"
    echo ""
    echo "Install missing tools:"
    echo "  task install-tools"
    echo ""
    echo "Or install individually, e.g.:"
    echo "  task install-terragrunt"
    echo "  task install-kubectl"
    exit 1
fi
