output "image_id" {
  description = "The ID of the downloaded Talos image in Proxmox"
  value       = proxmox_virtual_environment_download_file.talos_image.id
}

output "schematic_id" {
  description = "The Talos Image Factory schematic ID"
  value       = data.external.schematic_id.result.id
}

output "image_url" {
  description = "The URL of the Talos image"
  value       = local.nocloud_image_url
}

output "talos_version" {
  description = "The Talos version used"
  value       = var.talos_version
}

output "system_extensions" {
  description = "List of system extensions included in the image"
  value       = var.system_extensions
}
