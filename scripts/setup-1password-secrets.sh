#!/usr/bin/env bash
# Setup 1Password secrets for homelab
# This script creates items in 1Password following the recommended vault structure

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Vault name
VAULT="homelab"

echo -e "${GREEN}Setting up 1Password secrets for homelab${NC}"
echo ""

# Check if op CLI is available
if ! command -v op &> /dev/null; then
    echo -e "${RED}Error: 1Password CLI (op) is not installed${NC}"
    echo "Install it from: https://developer.1password.com/docs/cli/get-started/"
    exit 1
fi

# Check if authenticated
if ! op vault list &> /dev/null; then
    echo -e "${YELLOW}Not authenticated. Please sign in to 1Password${NC}"
    op signin
fi

# Check if vault exists
if ! op vault get "$VAULT" &> /dev/null; then
    echo -e "${YELLOW}Vault '$VAULT' not found. Creating it...${NC}"
    op vault create "$VAULT"
fi

echo -e "${GREEN}✓ Connected to 1Password${NC}"
echo ""

# Function to create or update an item
create_or_update_item() {
    local item_name="$1"
    local category="$2"
    shift 2
    local fields=("$@")

    echo -e "${YELLOW}Creating/updating: ${item_name}${NC}"

    # Check if item exists
    if op item get "${item_name}" --vault "$VAULT" &> /dev/null; then
        echo "  Item already exists, updating..."
        # Build edit command using array
        local cmd=(op item edit "${item_name}" --vault "$VAULT")
        for field in "${fields[@]}"; do
            cmd+=("$field")
        done
        "${cmd[@]}" < /dev/null
    else
        echo "  Creating new item..."
        # Build create command using array
        local cmd=(op item create --category "$category" --title "${item_name}" --vault "$VAULT")
        for field in "${fields[@]}"; do
            cmd+=("$field")
        done
        "${cmd[@]}" < /dev/null
    fi
    echo -e "${GREEN}  ✓ Done${NC}"
}

# ============================================================================
# Proxmox
# ============================================================================
echo -e "${GREEN}[1/5] Setting up Proxmox secrets${NC}"
echo -e "${YELLOW}Please provide Proxmox credentials:${NC}"
read -p "Proxmox API URL [https://172.16.100.250:8006/api2/json]: " proxmox_api_url
proxmox_api_url=${proxmox_api_url:-https://172.16.100.250:8006/api2/json}
read -p "Proxmox API Token ID [root@pam!terraform]: " proxmox_token_id
proxmox_token_id=${proxmox_token_id:-root@pam!terraform}
read -sp "Proxmox API Token Secret: " proxmox_token_secret
echo ""
read -p "Proxmox Node Name [pve]: " proxmox_node
proxmox_node=${proxmox_node:-pve}

create_or_update_item "proxmox" "Server" \
    "api_url[text]=${proxmox_api_url}" \
    "api_token_id[text]=${proxmox_token_id}" \
    "api_token_secret[password]=${proxmox_token_secret}" \
    "node[text]=${proxmox_node}"

echo ""

# ============================================================================
# Cloudflare
# ============================================================================
echo -e "${GREEN}[2/5] Setting up Cloudflare secrets${NC}"
echo -e "${YELLOW}Please provide Cloudflare credentials:${NC}"
read -sp "Cloudflare API Token: " cloudflare_api_token
echo ""
read -p "Cloudflare Zone ID: " cloudflare_zone_id

create_or_update_item "cloudflare" "API Credential" \
    "api_token[password]=${cloudflare_api_token}" \
    "zone_id[text]=${cloudflare_zone_id}"

echo ""

# ============================================================================
# 1Password Connect
# ============================================================================
echo -e "${GREEN}[3/5] Setting up 1Password Connect secrets${NC}"
echo -e "${YELLOW}Please provide 1Password Connect credentials:${NC}"
read -p "1Password Connect Host [https://1password-connect.ryanmcafee.com]: " connect_host
connect_host=${connect_host:-https://1password-connect.ryanmcafee.com}
read -sp "1Password Connect Token: " connect_token
echo ""
read -sp "1Password Service Account Token: " service_account_token
echo ""

create_or_update_item "onepassword-connect" "API Credential" \
    "connect_host[text]=${connect_host}" \
    "connect_token[password]=${connect_token}" \
    "service_account_token[password]=${service_account_token}"

echo ""

# ============================================================================
# TrueNAS
# ============================================================================
echo -e "${GREEN}[4/5] Setting up TrueNAS secrets${NC}"
echo -e "${YELLOW}Note: You need to create a TrueNAS API key first${NC}"
echo "Visit: http://172.16.100.10/ui/system/api-keys and create an API key"
echo ""
read -sp "Enter TrueNAS API key (or press Enter to skip): " truenas_api_key
echo ""

if [ -n "$truenas_api_key" ]; then
    create_or_update_item "truenas" "Server" \
        "api_key[password]=${truenas_api_key}" \
        "host[text]=172.16.100.10"
else
    echo -e "${YELLOW}Skipping TrueNAS setup${NC}"
fi

echo ""

# ============================================================================
# Network Configuration
# ============================================================================
echo -e "${GREEN}[5/5] Setting up Network Configuration${NC}"
echo -e "${YELLOW}Please provide network configuration:${NC}"
read -p "Gateway IP [172.16.100.1]: " gateway_ip
gateway_ip=${gateway_ip:-172.16.100.1}
read -p "DNS Server [172.16.100.1]: " dns_server
dns_server=${dns_server:-172.16.100.1}
read -p "Domain [ryanmcafee.com]: " domain
domain=${domain:-ryanmcafee.com}

create_or_update_item "network-config" "Server" \
    "gateway[text]=${gateway_ip}" \
    "dns[text]=${dns_server}" \
    "domain[text]=${domain}"

echo ""
echo -e "${GREEN}✓ All secrets configured successfully!${NC}"
echo ""
echo "Next steps:"
echo "1. Verify items in 1Password: op item list --vault homelab"
echo "2. Export ONEPASSWORD_CONNECT_* variables for Terraform"
echo "3. Configure ansible-vault password from 1Password"
