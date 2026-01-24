# Root Terragrunt Configuration
# This file contains shared configuration for all environments

locals {
  # Load environment-specific configuration if it exists
  environment_vars = try(read_terragrunt_config(find_in_parent_folders("env.hcl")), {})

  # Extract commonly used variables
  env       = try(local.environment_vars.locals.environment, "")
  project   = "homelab"
  base_fqdn = "ryanmcafee.com"
}

# Configure Terragrunt to automatically store tfstate files in local backend
# Production deployments should use remote backend (S3, GCS, etc.)
remote_state {
  backend = "local"

  config = {
    path = "${get_parent_terragrunt_dir()}/terraform.tfstate.d/${path_relative_to_include()}/terraform.tfstate"
  }

  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
}

# Generate provider configuration for all modules
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"

  contents = <<-EOF
    terraform {
      required_version = ">= 1.7.0"

      required_providers {
        proxmox = {
          source  = "bpg/proxmox"
          version = "~> 0.93.0"
        }
        talos = {
          source  = "siderolabs/talos"
          version = "~> 0.10.0"
        }
        kubernetes = {
          source  = "hashicorp/kubernetes"
          version = "~> 3.0.0"
        }
        helm = {
          source  = "hashicorp/helm"
          version = "~> 3.1.0"
        }
        kubectl = {
          source  = "alekc/kubectl"
          version = "~> 2.0"
        }
        kind = {
          source  = "tehcyx/kind"
          version = "~> 0.4.0"
        }
        onepassword = {
          source  = "1Password/onepassword"
          version = "~> 2.1.0"
        }
        unifi = {
          source  = "ubiquiti-community/unifi"
          version = "~> 0.41.0"
        }
      }
    }
  EOF
}

# Input variables that can be overridden by environment
inputs = merge(
  try(local.environment_vars.locals, {}),
  {
    project   = local.project
    base_fqdn = local.base_fqdn
  }
)
