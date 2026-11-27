# Merges over the root-generated required_providers; unifi_setting.syslog uses the 0.65 nested this_controller and netconsole objects.
terraform {
  required_providers {
    unifi = {
      source  = "ubiquiti-community/unifi"
      version = "~> 0.65.0"
    }
  }
}
