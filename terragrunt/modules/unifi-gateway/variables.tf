# BGP Configuration
variable "bgp_enabled" {
  description = "Enable BGP configuration on UniFi gateway"
  type        = bool
  default     = true
}

variable "bgp_description" {
  description = "Description for the BGP configuration"
  type        = string
  default     = "MetalLB BGP Peering"
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
  description = "Networks to advertise via BGP (optional - MetalLB advertises its own)"
  type        = list(string)
  default     = []
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
