variable "talos_version" {
  description = "Talos Linux version (e.g., 'v1.6.0')"
  type        = string
  default     = "v1.6.0"
}

variable "node_name" {
  description = "Proxmox node where the image will be downloaded"
  type        = string
}

variable "datastore_id" {
  description = "Proxmox datastore for the image"
  type        = string
  default     = "local"
}

variable "system_extensions" {
  description = "List of official Talos system extensions to include"
  type        = list(string)
  default = [
    "siderolabs/qemu-guest-agent",
    "siderolabs/intel-ucode",
    "siderolabs/i915-ucode",
  ]
}

variable "verify_checksum" {
  description = "Verify image checksum after download"
  type        = bool
  default     = false
}

variable "save_schematic" {
  description = "Save schematic JSON to local file for reference"
  type        = bool
  default     = true
}
