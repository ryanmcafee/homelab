/**
 * Talos Image Factory Module
 *
 * Generates custom Talos Linux images with system extensions via Image Factory.
 * Downloads the resulting image to Proxmox for VM provisioning.
 */

terraform {
  required_version = ">= 1.7.0"
}

locals {
  # Image Factory API endpoint
  image_factory_url = "https://factory.talos.dev"

  # Schematic configuration
  schematic = {
    customization = {
      systemExtensions = {
        officialExtensions = var.system_extensions
      }
    }
  }

  # Generate schematic JSON
  schematic_json = jsonencode(local.schematic)

  # Image URLs
  image_base_url = "${local.image_factory_url}/image/${data.external.schematic_id.result.id}/${var.talos_version}"
  nocloud_image_url = "${local.image_base_url}/nocloud-amd64.raw.xz"
}

# Generate schematic ID from Image Factory
data "external" "schematic_id" {
  program = ["bash", "-c", <<-EOF
    SCHEMATIC='${local.schematic_json}'
    RESPONSE=$(curl -s -X POST \
      -H "Content-Type: application/json" \
      -d "$SCHEMATIC" \
      ${local.image_factory_url}/schematics)
    echo "$RESPONSE" | jq -c '{id: .id}'
  EOF
  ]
}

# Download Talos image to Proxmox
resource "proxmox_virtual_environment_download_file" "talos_image" {
  content_type = "iso"
  datastore_id = var.datastore_id
  node_name    = var.node_name
  url          = local.nocloud_image_url
  file_name    = "talos-${var.talos_version}-${substr(data.external.schematic_id.result.id, 0, 8)}.img"

  # Checksum verification (optional)
  checksum            = var.verify_checksum ? data.external.image_checksum.result.checksum : null
  checksum_algorithm  = var.verify_checksum ? "sha256" : null

  # Only download if not already present
  overwrite = false

  # Upload timeout for large images
  upload_timeout = 600
}

# Get image checksum for verification
data "external" "image_checksum" {
  count = var.verify_checksum ? 1 : 0

  program = ["bash", "-c", <<-EOF
    CHECKSUM=$(curl -s ${local.nocloud_image_url}.sha256 | awk '{print $1}')
    echo "{\"checksum\": \"$CHECKSUM\"}"
  EOF
  ]
}

# Output schematic for reference
resource "local_file" "schematic" {
  count = var.save_schematic ? 1 : 0

  content  = local.schematic_json
  filename = "${path.module}/schematic-${data.external.schematic_id.result.id}.json"
}
