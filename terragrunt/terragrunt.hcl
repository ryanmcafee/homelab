# Root Terragrunt Configuration
# This file contains shared configuration for all environments

locals {
  # Load environment-specific configuration if it exists
  environment_vars = try(read_terragrunt_config(find_in_parent_folders("env.hcl")), {})

  # Extract commonly used variables. Nothing operator-specific is defined here:
  # this file is inherited by every unit in the tree, so a value set here is the
  # least visible kind of hard-coded identity there is. base_fqdn used to live
  # on this line, and because the inputs merge below put it *after* the
  # environment's own locals it also overrode any environment that tried to set
  # its own — including localdev, the environment a fork runs first.
  # base_fqdn now reaches the modules only through local.environment_vars, i.e.
  # only when an environment resolved it from the ConfigSet. An environment that
  # does not set it leaves the module variable unset and terraform stops, which
  # is the intended failure mode (docs/contracts/fork-ability.md).
  env     = try(local.environment_vars.locals.environment, "")
  project = "homelab"
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
        time = {
          source  = "hashicorp/time"
          version = ">= 0.9.0"
        }
      }
    }
  EOF
}

# Input variables that can be overridden by environment.
#
# Every environment local becomes a module input, except `config` — that is the
# environment's resolved ConfigSet, an implementation detail of env.hcl, and
# passing the whole map would put a few KB of TF_VAR_config on every unit and
# collide with any module that ever declares a `config` variable.
#
# The second map wins, so anything listed there is an override the environment
# cannot escape. Keep it to values that are the same for every operator: this
# used to carry base_fqdn, which is how one operator's domain reached all 13
# units including localdev.
inputs = merge(
  { for k, v in try(local.environment_vars.locals, {}) : k => v if k != "config" },
  {
    project = local.project
  }
)
