# Merges over the root-generated required_providers; unifi_setting.syslog needs >= 0.53.
terraform {
  required_providers {
    unifi = {
      source  = "ubiquiti-community/unifi"
      version = "~> 0.56.0"
    }
  }
}
