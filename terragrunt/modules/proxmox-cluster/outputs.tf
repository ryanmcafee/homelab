output "dns_records" {
  description = "Map of FQDN to DNS record ID"
  value       = { for fqdn, record in unifi_dns_record.this : fqdn => record.id }
}
