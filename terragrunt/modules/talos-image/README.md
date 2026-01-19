# Talos Image Factory Module

This module generates custom Talos Linux images with system extensions using the Talos Image Factory service and downloads them to Proxmox.

## Overview

The Talos Image Factory allows you to create custom Talos Linux images with additional system extensions. This module:

1. Generates a schematic configuration with desired extensions
2. Submits the schematic to Image Factory API
3. Receives a schematic ID
4. Downloads the custom Talos image to Proxmox

## System Extensions

Common system extensions for this homelab:

- **qemu-guest-agent**: Better VM integration with Proxmox
- **intel-ucode**: Intel CPU microcode updates
- **i915-ucode**: Intel integrated GPU firmware
- **nvidia-container-toolkit**: NVIDIA GPU support for containers
- **nfs-utils**: NFS client for CSI storage

## Usage

### Basic Configuration

```hcl
module "talos_image" {
  source = "../../modules/talos-image"

  talos_version = "v1.6.0"
  node_name     = "pve"
  datastore_id  = "local"

  system_extensions = [
    "siderolabs/qemu-guest-agent",
    "siderolabs/intel-ucode",
    "siderolabs/i915-ucode",
  ]
}
```

### With GPU Support

```hcl
module "talos_image_gpu" {
  source = "../../modules/talos-image"

  talos_version = "v1.6.0"
  node_name     = "pve"
  datastore_id  = "local"

  system_extensions = [
    "siderolabs/qemu-guest-agent",
    "siderolabs/intel-ucode",
    "siderolabs/nvidia-container-toolkit",  # For GPU passthrough
    "siderolabs/nfs-utils",                 # For NFS CSI
  ]

  verify_checksum = true
  save_schematic  = true
}
```

## How It Works

### 1. Schematic Generation

The module creates a schematic JSON:
```json
{
  "customization": {
    "systemExtensions": {
      "officialExtensions": [
        "siderolabs/qemu-guest-agent",
        "siderolabs/intel-ucode"
      ]
    }
  }
}
```

### 2. Image Factory API

```bash
# Submit schematic
curl -X POST https://factory.talos.dev/schematics \
  -H "Content-Type: application/json" \
  -d @schematic.json

# Response: {"id": "abc123..."}

# Download image
curl -O https://factory.talos.dev/image/abc123.../v1.6.0/nocloud-amd64.raw.xz
```

### 3. Proxmox Download

The module downloads the image to Proxmox storage for use with VMs.

## Variables

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| talos_version | Talos version | `string` | "v1.6.0" | no |
| node_name | Proxmox node | `string` | n/a | yes |
| datastore_id | Proxmox datastore | `string` | "local" | no |
| system_extensions | System extensions list | `list(string)` | See variables.tf | no |
| verify_checksum | Verify checksum | `bool` | false | no |
| save_schematic | Save schematic to file | `bool` | true | no |

## Outputs

| Name | Description |
|------|-------------|
| image_id | Proxmox image ID |
| schematic_id | Image Factory schematic ID |
| image_url | Image download URL |
| talos_version | Talos version |
| system_extensions | Included extensions |

## Available System Extensions

### Official Extensions

| Extension | Description |
|-----------|-------------|
| qemu-guest-agent | QEMU guest agent for better VM integration |
| intel-ucode | Intel CPU microcode updates |
| amd-ucode | AMD CPU microcode updates |
| i915-ucode | Intel GPU firmware |
| nvidia-container-toolkit | NVIDIA GPU support |
| nfs-utils | NFS client utilities |
| iscsi-tools | iSCSI initiator tools |
| util-linux-tools | Additional Linux utilities |
| drbd | Distributed Replicated Block Device |
| gasket-driver | Google Coral TPU support |

### Finding Extensions

Browse available extensions:
- [Talos Extensions Repository](https://github.com/siderolabs/extensions)
- [Image Factory Docs](https://www.talos.dev/v1.6/talos-guides/install/boot-assets/)

## Prerequisites

### Required Tools

The module requires:
- `curl` - For API calls
- `jq` - For JSON processing
- `bash` - For shell scripts

Install on Debian/Ubuntu:
```bash
apt-get install -y curl jq
```

Install on macOS:
```bash
brew install curl jq
```

## Image Types

The module downloads `nocloud-amd64.raw.xz` which is suitable for:
- Proxmox VMs
- QEMU/KVM
- Cloud-init enabled environments

Other available formats:
- `metal-amd64.iso` - Bare metal installation
- `aws-amd64.raw.xz` - AWS AMIs
- `azure-amd64.vhd.xz` - Azure images
- `gcp-amd64.raw.tar.gz` - Google Cloud images

## Troubleshooting

### Schematic ID Generation Fails

```bash
# Test API manually
curl -X POST https://factory.talos.dev/schematics \
  -H "Content-Type: application/json" \
  -d '{"customization":{"systemExtensions":{"officialExtensions":["siderolabs/qemu-guest-agent"]}}}'
```

### Image Download Timeout

- Increase `upload_timeout` in module
- Check network connectivity to factory.talos.dev
- Verify Proxmox can download external files

### Checksum Verification Fails

- Disable checksum verification: `verify_checksum = false`
- Manually verify:
  ```bash
  curl -s https://factory.talos.dev/image/<id>/<version>/nocloud-amd64.raw.xz.sha256
  ```

## Notes

- Image Factory caches images for 24 hours
- Schematic IDs are deterministic (same extensions = same ID)
- Images are compressed with xz (excellent compression ratio)
- Decompression happens automatically during VM creation
- Keep Talos version synchronized across all nodes

## Version Compatibility

| Talos Version | Kubernetes Version | Notes |
|---------------|-------------------|-------|
| v1.6.x | v1.29.x | Current stable |
| v1.5.x | v1.28.x | Previous stable |
| v1.7.x | v1.30.x | Latest (may be beta) |

## Related Documentation

- [Talos Image Factory](https://www.talos.dev/v1.6/talos-guides/install/boot-assets/)
- [System Extensions](https://github.com/siderolabs/extensions)
- [Talos Installation Guide](https://www.talos.dev/v1.6/introduction/getting-started/)
