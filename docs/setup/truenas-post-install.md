# TrueNAS Post-Installation Configuration

Automated configuration of TrueNAS after VM installation via Ansible playbooks.

## Prerequisites

- TrueNAS VM deployed via Terraform (`task terragrunt:apply:truenas`)
- TrueNAS initial setup completed (admin password configured)
- SSH access to TrueNAS (optional, API is preferred)
- TrueNAS API key generated

## Step 1: Complete Initial TrueNAS Setup

After the TrueNAS VM boots:

1. Access TrueNAS Web UI at `https://172.16.100.50`
2. Complete initial setup wizard
3. Set admin password
4. Configure network if needed (should auto-configure via DHCP/static)

## Step 2: Generate API Key

1. Log into TrueNAS Web UI
2. Navigate to **Settings** → **API Keys**
3. Click **Add**
4. Name: `ansible-automation`
5. Click **Add** and copy the generated key

Store the key securely:

```bash
# Option 1: Environment variable (temporary)
export TRUENAS_API_KEY="your-api-key-here"

# Option 2: Store in 1Password
op item create --category=api-credential --title="TrueNAS API Key" credential="your-api-key-here"
```

## Step 3: Create ZFS Pool (Manual)

The ZFS pool must be created manually for safety:

1. Navigate to **Storage** → **Pools**
2. Click **Add**
3. Select pool type:
   - **Mirror** for 2 drives (recommended for boot/critical)
   - **RAIDZ1** for 3+ drives (1 parity drive)
   - **RAIDZ2** for 4+ drives (2 parity drives)
4. Select drives passed through via HBA
5. Name the pool: `tank`
6. Click **Create**

## Step 4: Run Ansible Setup

Configure TrueNAS with Ansible:

```bash
# Check TrueNAS status
task truenas:status

# Run full setup (creates datasets, NFS shares, API key)
task truenas:setup

# Or run with verbose output
task truenas:setup -- -v
```

## What Gets Configured

The Ansible playbook configures:

### Datasets

| Dataset | Purpose | Quota |
|---------|---------|-------|
| `tank/k8s` | Kubernetes persistent volumes | 500GB |
| `tank/media` | Media storage (Plex, etc.) | 100TB |
| `tank/backups` | Backup storage | 50TB |
| `tank/downloads` | Temporary downloads | 10TB |

### NFS Shares

| Share | Path | Access |
|-------|------|--------|
| Kubernetes | `/mnt/tank/k8s` | 172.16.100.0/24 |

### Services

- NFS server enabled and started
- iSCSI (optional, disabled by default)

### API Keys

- `democratic-csi` key created for storage provisioning

## Step 5: Configure democratic-csi

After running the setup, store the generated API key:

1. Check `/tmp/truenas-csi-api-key.txt` for the key
2. Store in 1Password:

```bash
op item create --category=api-credential \
  --title="democratic-csi TrueNAS API Key" \
  credential="$(cat /tmp/truenas-csi-api-key.txt | grep TRUENAS_CSI_API_KEY | cut -d= -f2)"
```

3. Remove the temporary file:

```bash
rm /tmp/truenas-csi-api-key.txt
```

## Verification

### Test NFS Mount

From a Talos node or workstation:

```bash
# Create test mount point
mkdir -p /mnt/test

# Mount NFS share
mount -t nfs 172.16.100.50:/mnt/tank/k8s /mnt/test

# Verify write access
touch /mnt/test/test-file
rm /mnt/test/test-file

# Unmount
umount /mnt/test
```

### Verify Kubernetes Storage Class

After deploying the addons chart:

```bash
# Check storage class
kubectl get storageclass

# Create test PVC
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: democratic-csi-nfs
  resources:
    requests:
      storage: 1Gi
EOF

# Verify PVC bound
kubectl get pvc test-pvc

# Cleanup
kubectl delete pvc test-pvc
```

## Troubleshooting

### API Connection Failed

```bash
# Verify TrueNAS is reachable
ping 172.16.100.50

# Test API endpoint
curl -k -H "Authorization: Bearer $TRUENAS_API_KEY" \
  https://172.16.100.50/api/v2.0/system/info
```

### NFS Mount Failed

```bash
# Check NFS service on TrueNAS
curl -k -H "Authorization: Bearer $TRUENAS_API_KEY" \
  https://172.16.100.50/api/v2.0/service | jq '.[] | select(.service=="nfs")'

# Check exports
showmount -e 172.16.100.50
```

### Pool Not Visible

Verify HBA passthrough is working:

1. Check TrueNAS **Storage** → **Disks**
2. Verify disks from HBA are visible
3. If not, check Proxmox PCI passthrough configuration

## Reference

- [TrueNAS Scale Documentation](https://www.truenas.com/docs/scale/)
- [democratic-csi Documentation](https://github.com/democratic-csi/democratic-csi)
- [NFS Client Setup](https://www.truenas.com/docs/scale/scaleclireference/service/clinfs/)
