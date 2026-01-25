output "vm_id" {
  description = "The ID of the TrueNAS VM"
  value       = proxmox_virtual_environment_vm.truenas.id
}

output "vm_name" {
  description = "The name of the TrueNAS VM"
  value       = proxmox_virtual_environment_vm.truenas.name
}

output "ipv4_addresses" {
  description = "IPv4 addresses assigned to TrueNAS"
  value       = proxmox_virtual_environment_vm.truenas.ipv4_addresses
}

output "mac_addresses" {
  description = "MAC addresses of TrueNAS network interfaces"
  value       = proxmox_virtual_environment_vm.truenas.mac_addresses
}

output "iso_id" {
  description = "The ID of the downloaded TrueNAS ISO"
  value       = var.use_template ? null : proxmox_virtual_environment_download_file.truenas_iso[0].id
}

output "dns_records" {
  description = "Map of FQDN to DNS record ID"
  value       = { for fqdn, record in unifi_dns_record.this : fqdn => record.id }
}
