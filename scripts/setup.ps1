# PowerShell setup script for Windows
param(
    [string]$Environment = ""
)

$ErrorActionPreference = "Stop"

# Colors for output
function Write-Step($Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Success($Message) {
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-ErrorMsg($Message) {
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Write-WarningMsg($Message) {
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

# Function to install mise
function Install-Mise {
    if (Get-Command mise -ErrorAction SilentlyContinue) {
        $miseVersion = mise --version 2>&1 | Out-String
        Write-Success "mise is already installed ($miseVersion)"
        return $true
    }

    Write-Step "Installing mise..."

    try {
        # Install via PowerShell script
        Invoke-Expression "& { $(Invoke-RestMethod https://mise.run) }"

        # Add to current session
        $env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"

        Write-Success "mise installed successfully"
        Write-WarningMsg "Add mise to your PowerShell profile:"
        Write-Host '  mise activate pwsh | Out-String | Invoke-Expression'
        Write-Host ""

        return $true
    }
    catch {
        Write-ErrorMsg "Failed to install mise: $_"
        return $false
    }
}

# Function to install all tools
function Install-Tools {
    Write-Step "Installing all dependencies via mise..."

    $projectRoot = Split-Path -Parent $PSScriptRoot
    Set-Location $projectRoot

    try {
        mise install -y
        if ($LASTEXITCODE -eq 0) {
            Write-Success "All tools installed via mise"
            return $true
        }
        else {
            Write-ErrorMsg "Tool installation failed"
            Write-Host "Run 'mise doctor' for diagnostics"
            return $false
        }
    }
    catch {
        Write-ErrorMsg "Tool installation failed: $_"
        return $false
    }
}

# Function to confirm action
function Confirm-Action($Message) {
    $response = Read-Host "$Message [y/N]"
    return $response -match '^[yY]([eE][sS])?$'
}

# Main execution
Write-Host "======================================"
Write-Host "  Homelab Infrastructure Setup"
Write-Host "======================================"
Write-Host ""

# Step 0: Install mise and tools
if (-not (Install-Mise)) {
    exit 1
}

if (-not (Install-Tools)) {
    exit 1
}

# Step 1: Validate prerequisites
Write-Step "Validating prerequisites..."
$validateScript = Join-Path $PSScriptRoot "validate-prerequisites.sh"
if (Test-Path $validateScript) {
    bash $validateScript
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorMsg "Prerequisites validation failed"
        Write-Host ""
        Write-Host "Run: mise doctor"
        exit 1
    }
    Write-Success "Prerequisites validated"
    Write-Host ""
}
else {
    Write-WarningMsg "validate-prerequisites.sh not found, skipping validation"
    Write-Host ""
}

# Step 2: Check environment
Write-Step "Checking environment configuration..."

if (-not $env:TF_VAR_proxmox_api_url) {
    Write-WarningMsg "Environment variables not set"
    Write-Host "Please copy .envrc.example to .envrc and fill in your values"
    Write-Host "Then run: direnv allow"

    if (-not (Confirm-Action "Continue without environment variables?")) {
        exit 1
    }
}
Write-Success "Environment checked"
Write-Host ""

# Step 3: Determine deployment target
if (-not $Environment) {
    Write-Host "Select deployment target:"
    Write-Host "  1) localdev  - Local Kind cluster (no hardware required)"
    Write-Host "  2) dev       - Development environment (Proxmox)"
    Write-Host "  3) prod      - Production environment (Proxmox)"
    Write-Host ""
    $choice = Read-Host "Enter choice [1-3]"

    switch ($choice) {
        "1" { $Environment = "localdev" }
        "2" { $Environment = "dev" }
        "3" { $Environment = "prod" }
        default {
            Write-ErrorMsg "Invalid choice"
            exit 1
        }
    }
}

# Step 4: Execute deployment based on environment
switch ($Environment) {
    "localdev" {
        Write-Step "Setting up local development environment..."
        Write-Host ""

        Write-Step "Creating Kind cluster..."
        $projectRoot = Split-Path -Parent $PSScriptRoot
        Set-Location $projectRoot
        task localdev:kind

        if ($LASTEXITCODE -eq 0) {
            Write-Success "Kind cluster created"
        }
        else {
            Write-ErrorMsg "Failed to create Kind cluster"
            exit 1
        }
        Write-Host ""

        Write-Step "Starting Tilt..."
        Write-Host "Tilt will start in the background"
        Write-Host "Access Tilt UI at: http://localhost:10350"
        Write-Host ""
        Write-Host "Services will be available at:"
        Write-Host "  - ArgoCD:  http://localhost:8080"
        Write-Host "  - Traefik: http://localhost:9080"
        Write-Host "  - Grafana: http://localhost:3000"
        Write-Host ""

        if (Confirm-Action "Start Tilt now?") {
            Set-Location (Join-Path $projectRoot "localdev")
            tilt up
        }
        else {
            Write-Host "Run 'task localdev:tilt' to start Tilt later"
        }
    }

    { $_ -eq "dev" -or $_ -eq "prod" } {
        Write-Step "Setting up $Environment environment..."
        Write-Host ""

        Write-Step "Phase 1: Proxmox Installation"
        Write-Host "This phase must be completed manually."
        Write-Host "See plan.md Phase 1 for detailed instructions."
        Write-Host ""

        if (-not (Confirm-Action "Has Proxmox been installed and is accessible?")) {
            Write-WarningMsg "Please install Proxmox first"
            exit 1
        }
        Write-Success "Proxmox installation confirmed"
        Write-Host ""

        Write-Step "Phase 2: Proxmox Configuration (Ansible)"
        if (Confirm-Action "Run Ansible playbooks to configure Proxmox?") {
            $projectRoot = Split-Path -Parent $PSScriptRoot
            Set-Location (Join-Path $projectRoot "ansible")
            ansible-playbook playbooks/site.yml
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Proxmox configured via Ansible"
            }
        }
        else {
            Write-WarningMsg "Skipped Ansible configuration"
            Write-Host "Run manually: task ansible:apply"
        }
        Write-Host ""

        Write-Step "Phase 3: Infrastructure Provisioning (Terragrunt)"
        if (Confirm-Action "Run Terragrunt to provision infrastructure?") {
            $projectRoot = Split-Path -Parent $PSScriptRoot
            Set-Location (Join-Path $projectRoot "terragrunt\environments\$Environment")
            terragrunt run-all apply
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Infrastructure provisioned via Terragrunt"
            }
        }
        else {
            Write-WarningMsg "Skipped Terragrunt provisioning"
            Write-Host "Run manually: task tf:apply ENV=$Environment"
        }
        Write-Host ""

        Write-Step "Phase 4: GitOps Bootstrap"
        Write-Host "ArgoCD should now be deployed and managing the cluster"
        Write-Host ""

        Write-Step "Retrieving ArgoCD admin password..."
        if (Get-Command kubectl -ErrorAction SilentlyContinue) {
            try {
                $argoCDPassword = kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' 2>$null | ForEach-Object { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($_)) }
                if ($argoCDPassword) {
                    Write-Host "ArgoCD admin password: $argoCDPassword"
                    Write-Host ""
                    Write-Host "Access ArgoCD at: https://argocd.ryanmcafee.com"
                    Write-Host "Username: admin"
                }
            }
            catch {
                Write-WarningMsg "Could not retrieve ArgoCD password (may not be deployed yet)"
            }
        }
    }
}

Write-Host ""
Write-Host "======================================"
Write-Success "Setup complete!"
Write-Host "======================================"
Write-Host ""

# Print next steps
Write-Host "Next steps:"
switch ($Environment) {
    "localdev" {
        Write-Host "  1. Check Tilt UI for deployment status"
        Write-Host "  2. Access ArgoCD to see GitOps in action"
        Write-Host "  3. Make changes to charts/ and see live updates"
        Write-Host ""
        Write-Host "Useful commands:"
        Write-Host "  task localdev:logs    - Stream logs from all pods"
        Write-Host "  task localdev:down    - Tear down environment"
        Write-Host "  task chart:lint       - Lint Helm charts"
    }
    { $_ -eq "dev" -or $_ -eq "prod" } {
        Write-Host "  1. Verify cluster health: kubectl get nodes"
        Write-Host "  2. Check ArgoCD applications: kubectl get applications -n argocd"
        Write-Host "  3. Monitor pod deployments: kubectl get pods -A"
        Write-Host "  4. Access ArgoCD UI to see GitOps status"
        Write-Host ""
        Write-Host "Useful commands:"
        Write-Host "  task k8s:status       - Show cluster status"
        Write-Host "  task k8s:argocd-password - Get ArgoCD admin password"
    }
}
Write-Host ""
