variable "dns_entries" {
  description = "List of DNS entries to create"
  type = list(object({
    fqdn = string
    type = string
    host = string
  }))
  default = []
}

variable "dns_ttl" {
  description = "TTL for DNS records in seconds"
  type        = number
  default     = 300
}
