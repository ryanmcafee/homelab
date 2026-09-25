# BGP Configuration
variable "bgp_enabled" {
  description = "Enable BGP configuration on UniFi gateway"
  type        = bool
  default     = true
}

variable "bgp_description" {
  description = "Description for the BGP configuration"
  type        = string
  default     = "Cilium BGP Peering"
}

variable "bgp_local_as" {
  description = "Local Autonomous System number for the UniFi gateway"
  type        = number
}

variable "bgp_router_id" {
  description = "BGP router ID (typically the gateway IP)"
  type        = string
}

variable "bgp_neighbors" {
  description = "List of BGP neighbors to peer with"
  type = list(object({
    address     = string
    remote_as   = number
    description = string
    password    = optional(string)
  }))
}

variable "bgp_networks" {
  description = "Networks to advertise via BGP (optional - Cilium advertises the LoadBalancer IPs itself)"
  type        = list(string)
  default     = []
}

variable "bgp_maximum_paths" {
  description = "ECMP paths installed per prefix (maximum-paths); null uses the number of neighbors"
  type        = number
  default     = null
}

variable "bgp_log_neighbor_changes" {
  description = "Log BGP neighbor state changes"
  type        = bool
  default     = true
}

variable "site" {
  description = "UniFi site name"
  type        = string
  default     = "default"
}

# Telemetry exports (docs/logging.md, "UniFi gateway")
variable "telemetry_enabled" {
  description = "Point the UniFi activity log (SIEM syslog) and NetFlow/IPFIX exports at the OpenTelemetry gateway collector"
  type        = bool
  default     = false
}

variable "telemetry_collector_ip" {
  description = "LoadBalancer IP of the OpenTelemetry gateway collector (OTEL_LB_IP)"
  type        = string
  default     = null

  validation {
    condition     = var.telemetry_collector_ip == null || can(cidrhost("${var.telemetry_collector_ip}/32", 0))
    error_message = "telemetry_collector_ip must be an IPv4 address."
  }
}

variable "syslog_port" {
  description = "UDP port of the collector's syslog listener"
  type        = number
  default     = 514
}

variable "netflow_port" {
  description = "UDP port of the collector's NetFlow/IPFIX listener"
  type        = number
  default     = 2055
}

variable "unifi_setting_script" {
  description = "Path to scripts/unifi-setting.ts, which writes UniFi settings the provider does not model"
  type        = string
  default     = null
}

variable "unifi_insecure" {
  description = "Let unifi_setting_script accept the controller's self-signed TLS certificate"
  type        = bool
  default     = false
}
