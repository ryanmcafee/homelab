#!/usr/bin/env bash
# Validate prerequisites using mise

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=================================="
echo "Homelab Prerequisites Validation"
echo "=================================="
echo ""

# Check if mise is installed
if ! command -v mise &> /dev/null; then
    echo -e "${RED}✗${NC} mise is not installed"
    echo ""
    echo "mise is required to manage all dependencies."
    echo "Run ./scripts/setup.sh to install mise and all dependencies"
    exit 1
fi

echo -e "${GREEN}✓${NC} mise is installed ($(mise --version))"
echo ""

# Check mise doctor output
echo "Running mise doctor..."
echo ""
if mise doctor; then
    echo ""
    echo -e "${GREEN}✓${NC} mise doctor passed"
else
    echo ""
    echo -e "${YELLOW}⚠${NC} mise doctor found some issues (may be non-critical)"
fi

echo ""
echo "=================================="
echo "Validating individual tools..."
echo "=================================="
echo ""

# Run mise validation task
if mise run validate; then
    echo ""
    echo -e "${GREEN}✓${NC} All tools validated successfully"
else
    echo ""
    echo -e "${RED}✗${NC} Tool validation failed"
    echo ""
    echo "Run 'mise install -y' to install missing tools"
    exit 1
fi

# Check for .envrc if using production
echo ""
echo "=================================="
echo "Environment Configuration"
echo "=================================="
echo ""

if [ -f ".envrc" ]; then
    echo -e "${GREEN}✓${NC} .envrc file exists"

    if [ -n "${TF_VAR_proxmox_api_url:-}" ]; then
        echo -e "${GREEN}✓${NC} Environment variables loaded"
    else
        echo -e "${YELLOW}⚠${NC} .envrc exists but not loaded"
        echo "  Run 'direnv allow' to load environment variables"
    fi
else
    echo -e "${YELLOW}⚠${NC} .envrc file not found"
    echo "  Copy .envrc.example to .envrc and configure for homelab"
    echo "  Required for Proxmox deployments"
fi

# Check for Docker (external prerequisite)
echo ""
echo "=================================="
echo "External Prerequisites"
echo "=================================="
echo ""

if command -v docker &> /dev/null; then
    echo -e "${GREEN}✓${NC} Docker is installed ($(docker --version))"
else
    echo -e "${YELLOW}⚠${NC} Docker is not installed"
    echo "  Docker is required for local development (Kind)"
    echo "  Install Docker Desktop: https://www.docker.com/products/docker-desktop"
fi

echo ""
echo "=================================="
echo -e "${GREEN}Prerequisites validation complete!${NC}"
echo "=================================="
echo ""

echo "Next steps:"
echo "  For local development: task localdev:up"
echo "  For production setup: ./scripts/setup.sh"
echo ""
