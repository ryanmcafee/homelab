# Disaster Recovery and Backup Strategy

This document outlines comprehensive backup strategies, recovery procedures, and business continuity planning for the homelab infrastructure.

## Table of Contents

- [Overview](#overview)
- [Recovery Objectives](#recovery-objectives)
- [Backup Strategy](#backup-strategy)
- [Component-Specific Backups](#component-specific-backups)
- [Recovery Procedures](#recovery-procedures)
- [Testing and Validation](#testing-and-validation)
- [Automation](#automation)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

### Design Philosophy

**"Hope for the best, plan for the worst."**

The homelab backup strategy follows the **3-2-1 rule**:
- **3** copies of data
- **2** different storage media
- **1** off-site copy

### Disaster Scenarios

| Scenario | Impact | RTO | RPO | Recovery Method |
|----------|--------|-----|-----|-----------------|
| Pod crash | Single app | 30s | 0 | Kubernetes auto-restart |
| Node failure | Multiple apps | 5min | 0 | K8s reschedules pods |
| Control plane failure | Cluster degraded | 30min | 0 | Restore from etcd backup |
| Storage failure | Data loss | 2hr | 24hr | Restore from ZFS snapshots |
| Complete cluster loss | All apps down | 4hr | 24hr | Rebuild from Git + backups |
| Complete homelab loss | Everything down | 8hr | 24hr | Rebuild from scratch |
| Ransomware/corruption | Data compromised | 8hr | 24hr | Restore from immutable backups |

**Legend**:
- **RTO** (Recovery Time Objective): Maximum acceptable downtime
- **RPO** (Recovery Point Objective): Maximum acceptable data loss

---

## Recovery Objectives

### Tier 1: Critical Services (RTO: 30 minutes, RPO: 0)

- **Kubernetes Control Plane**: Required for all other services
- **Storage Layer (TrueNAS)**: Required for persistent data
- **Network Services**: DNS, ingress, load balancing

**Priority**: Immediate restoration required

### Tier 2: Important Services (RTO: 2 hours, RPO: 1 hour)

- **Home Assistant**: Home automation
- **Monitoring Stack**: Prometheus, Grafana
- **ArgoCD**: GitOps deployment

**Priority**: Restore within same day

### Tier 3: Standard Services (RTO: 8 hours, RPO: 24 hours)

- **Plex**: Media streaming
- **Media Management**: Sonarr, Radarr, Prowlarr
- **Other Applications**: Non-critical workloads

**Priority**: Restore within 1-2 days

---

## Backup Strategy

### Layer 1: Infrastructure as Code (Git)

**What's Backed Up**:
- Terraform/Terragrunt configurations
- Ansible playbooks
- Helm charts
- Kubernetes manifests
- Talos machine configs

**Storage**: GitHub (private repository)

**Frequency**: On every commit

**Retention**: Unlimited (Git history)

**Recovery**:
```bash
git clone https://github.com/username/homelab.git
cd homelab
./scripts/setup.sh
```

**RPO**: 0 (real-time)
**RTO**: 4-8 hours (full rebuild)

### Layer 2: Configuration Backups

**What's Backed Up**:
- Proxmox configuration (`/etc/pve`)
- TrueNAS configuration database
- Kubernetes etcd database
- 1Password vaults (vendor-managed)

**Storage**:
- Local: TrueNAS ZFS datasets
- Remote: Cloud storage (Backblaze B2)

**Frequency**: Hourly

**Retention**:
- Hourly: 24 hours
- Daily: 7 days
- Weekly: 4 weeks
- Monthly: 3 months

### Layer 3: Data Backups

**What's Backed Up**:
- Application persistent volumes
- Media library metadata
- Database dumps
- User data

**Storage**:
- Primary: TrueNAS ZFS snapshots
- Secondary: External USB drive (weekly)
- Tertiary: Cloud storage (monthly)

**Frequency**: Daily

**Retention**:
- Snapshots: 7 days
- Weekly backups: 4 weeks
- Monthly backups: 12 months

### Layer 4: Full System Backups

**What's Backed Up**:
- Proxmox VM backups (full disk images)
- TrueNAS ZFS pool backups
- Complete cluster state

**Storage**: External storage (separate physical location)

**Frequency**: Weekly

**Retention**: 4 weeks

---

## Component-Specific Backups

### Proxmox

#### Automated VM Backups

Proxmox supports built-in backup scheduling.

**Configuration** (via Ansible):

```yaml
# ansible/roles/proxmox-backup/tasks/main.yml
- name: Configure Proxmox backup storage
  proxmox_storage:
    name: backup-local
    type: dir
    path: /mnt/backups
    content: ['backup']
    state: present

- name: Schedule VM backups
  proxmox_backup_schedule:
    vmid: all
    storage: backup-local
    schedule: 'daily'
    starttime: '02:00'
    mode: snapshot
    compress: zstd
    retention:
      keep_last: 7
      keep_daily: 7
      keep_weekly: 4
      keep_monthly: 3
```

**Manual Backup**:

```bash
# Backup specific VM
vzdump 100 --storage backup-local --mode snapshot --compress zstd

# Backup all VMs
vzdump --all --storage backup-local --mode snapshot --compress zstd
```

**Restore**:

```bash
# List backups
ls /mnt/backups/dump/

# Restore VM
qmrestore /mnt/backups/dump/vzdump-qemu-100-2026_01_19-02_00_00.vma.zst 100

# Restore to new VM ID
qmrestore /mnt/backups/dump/vzdump-qemu-100-2026_01_19-02_00_00.vma.zst 200
```

#### Configuration Backup

**Manual Export**:

```bash
# Backup Proxmox configuration
tar -czf proxmox-config-$(date +%Y%m%d).tar.gz /etc/pve/

# Upload to TrueNAS
scp proxmox-config-*.tar.gz root@truenas:/mnt/storage/backups/proxmox/
```

**Restore**:

```bash
# Download from TrueNAS
scp root@truenas:/mnt/storage/backups/proxmox/proxmox-config-20260119.tar.gz .

# Restore configuration
tar -xzf proxmox-config-20260119.tar.gz -C /
systemctl restart pveproxy pvedaemon
```

### TrueNAS

#### ZFS Snapshots

**Automated Snapshots** (via TrueNAS UI):

1. Navigate to **Storage** → **Snapshots**
2. Click **Add** (periodic snapshot task)
3. Configure:
   - Dataset: `storage/kubernetes`
   - Recursive: Yes
   - Lifetime: `7d` (7 days)
   - Schedule: Hourly

**CLI Alternative**:

```bash
# Create snapshot
zfs snapshot -r storage/kubernetes@$(date +%Y%m%d-%H%M%S)

# List snapshots
zfs list -t snapshot

# Rollback to snapshot
zfs rollback storage/kubernetes@20260119-020000
```

#### ZFS Replication

**Setup Replication** (to external drive):

1. Attach USB drive to TrueNAS
2. Create pool: `zpool create backup /dev/sdX`
3. Configure replication:
   - Source: `storage/kubernetes`
   - Destination: `backup/kubernetes`
   - Schedule: Daily at 3 AM
   - Retention: 30 days

**Manual Replication**:

```bash
# Send snapshot to remote
zfs send storage/kubernetes@latest | ssh remote zfs receive backup/kubernetes

# Incremental send
zfs send -i storage/kubernetes@previous storage/kubernetes@latest | \
  ssh remote zfs receive backup/kubernetes
```

#### Configuration Backup

**Automated** (TrueNAS UI):

1. Navigate to **System** → **Advanced** → **Save Debug**
2. Download configuration file
3. Store in secure location

**CLI**:

```bash
# Export configuration
midclt call system.general.config | jq > truenas-config.json

# Import configuration
midclt call system.general.update "$(cat truenas-config.json)"
```

### Kubernetes (Talos)

#### etcd Backups

Talos automatically backs up etcd, but manual backups are recommended before major changes.

**Manual Backup**:

```bash
# Create etcd snapshot
talosctl -n <control-plane-ip> etcd snapshot /var/lib/etcd-backup.db

# Copy to local machine
talosctl -n <control-plane-ip> cp /var/lib/etcd-backup.db ./etcd-backup-$(date +%Y%m%d).db

# Upload to TrueNAS
scp etcd-backup-*.db root@truenas:/mnt/storage/backups/kubernetes/etcd/
```

**Automated Backup** (CronJob):

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  jobTemplate:
    spec:
      template:
        spec:
          hostNetwork: true
          containers:
            - name: backup
              image: bitnami/etcd:latest
              command:
                - /bin/sh
                - -c
                - |
                  ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%Y%m%d-%H%M%S).db \
                    --endpoints=https://127.0.0.1:2379 \
                    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                    --cert=/etc/kubernetes/pki/etcd/server.crt \
                    --key=/etc/kubernetes/pki/etcd/server.key
              volumeMounts:
                - name: etcd-certs
                  mountPath: /etc/kubernetes/pki/etcd
                  readOnly: true
                - name: backup
                  mountPath: /backup
          volumes:
            - name: etcd-certs
              hostPath:
                path: /etc/kubernetes/pki/etcd
            - name: backup
              nfs:
                server: truenas.local
                path: /mnt/storage/backups/kubernetes/etcd
          restartPolicy: OnFailure
```

**Restore etcd**:

See [runbooks/talos-recovery.md](./runbooks/talos-recovery.md) for complete procedure.

#### Persistent Volume Backups

**Velero Installation**:

```bash
# Install Velero CLI
wget https://github.com/vmware-tanzu/velero/releases/download/v1.12.0/velero-v1.12.0-linux-amd64.tar.gz
tar -xzf velero-v1.12.0-linux-amd64.tar.gz
sudo mv velero-v1.12.0-linux-amd64/velero /usr/local/bin/

# Install Velero in cluster
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.8.0 \
  --bucket homelab-velero \
  --secret-file ./credentials-velero \
  --use-volume-snapshots=true \
  --backup-location-config region=us-east-1,s3ForcePathStyle="true",s3Url=https://s3.us-east-1.backblazeb2.com \
  --snapshot-location-config region=us-east-1
```

**Create Backup**:

```bash
# Backup entire namespace
velero backup create media-backup --include-namespaces media

# Backup specific resources
velero backup create plex-backup \
  --include-namespaces media \
  --selector app=plex

# Schedule daily backups
velero schedule create daily-media \
  --schedule="0 2 * * *" \
  --include-namespaces media \
  --ttl 168h
```

**Restore**:

```bash
# List backups
velero backup get

# Restore from backup
velero restore create --from-backup media-backup

# Restore to different namespace
velero restore create --from-backup media-backup \
  --namespace-mappings media:media-restored
```

### Application Data

#### Database Backups

**PostgreSQL Example**:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup
  namespace: databases
spec:
  schedule: "0 1 * * *"  # Daily at 1 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: postgres:15
              command:
                - /bin/sh
                - -c
                - |
                  pg_dump -h postgres -U postgres -d mydb > /backup/mydb-$(date +%Y%m%d).sql
                  # Retain only last 7 days
                  find /backup -name "mydb-*.sql" -mtime +7 -delete
              env:
                - name: PGPASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: postgres-credentials
                      key: password
              volumeMounts:
                - name: backup
                  mountPath: /backup
          volumes:
            - name: backup
              persistentVolumeClaim:
                claimName: postgres-backup-pvc
          restartPolicy: OnFailure
```

#### Media Library Metadata

Plex, Sonarr, Radarr store metadata in databases and config files.

**Backup Strategy**:
1. PVCs backed up via Velero (daily)
2. ZFS snapshots of underlying storage (hourly)
3. Manual exports before major updates

**Manual Backup Example (Plex)**:

```bash
# Stop Plex
kubectl -n media scale deployment plex --replicas=0

# Backup Plex database
kubectl -n media exec -it plex-xxx -- tar -czf /tmp/plex-backup.tar.gz /config/Library

# Copy to local
kubectl -n media cp plex-xxx:/tmp/plex-backup.tar.gz ./plex-backup-$(date +%Y%m%d).tar.gz

# Restart Plex
kubectl -n media scale deployment plex --replicas=1

# Upload to TrueNAS
scp plex-backup-*.tar.gz root@truenas:/mnt/storage/backups/applications/plex/
```

---

## Recovery Procedures

### Scenario 1: Single Pod Failure

**Detection**: Pod in CrashLoopBackOff or Error state

**Recovery**:

```bash
# Check pod status
kubectl get pods -n media

# View logs
kubectl logs -n media plex-xxx

# Restart pod (delete, K8s recreates)
kubectl delete pod -n media plex-xxx

# If persistent: check PVC, resource limits, config
kubectl describe pod -n media plex-xxx
```

**RTO**: 30 seconds
**RPO**: 0 (no data loss)

### Scenario 2: Node Failure

**Detection**: Node status NotReady

**Recovery**:

```bash
# Check node status
kubectl get nodes

# Describe node for details
kubectl describe node talos-worker-1

# Kubernetes automatically reschedules pods to healthy nodes
# Monitor pod migration:
kubectl get pods -A -o wide --watch

# If node unrecoverable:
# 1. Drain node
kubectl drain talos-worker-1 --ignore-daemonsets --delete-emptydir-data

# 2. Delete node from cluster
kubectl delete node talos-worker-1

# 3. Provision new node via Terragrunt
cd terragrunt/environments/homelab/talos-cluster
terragrunt apply
```

**RTO**: 5 minutes (pod rescheduling)
**RPO**: 0 (no data loss if PVs are on network storage)

### Scenario 3: Control Plane Failure

**Detection**: Cannot access Kubernetes API

**Recovery**:

See [runbooks/talos-upgrade.md](./runbooks/talos-upgrade.md#emergency-recovery) for detailed procedure.

**Quick Steps**:

```bash
# Check control plane nodes
talosctl -n <cp-node-ip> health

# If one node down: etcd quorum maintained (2/3 nodes)
# Repair or replace failed node

# If majority down: restore from etcd backup
talosctl -n <cp-node-ip> etcd restore /path/to/etcd-backup.db
```

**RTO**: 30 minutes
**RPO**: Up to 6 hours (depends on etcd backup frequency)

### Scenario 4: Storage Failure

**Detection**: PVCs stuck in Pending, pods cannot mount volumes

**Recovery**:

```bash
# Check TrueNAS availability
ping truenas.local

# Check NFS exports
showmount -e truenas.local

# If TrueNAS down: restore from VM backup
# See runbooks/truenas-maintenance.md

# If dataset corrupted: restore from ZFS snapshot
zfs list -t snapshot | grep kubernetes
zfs rollback storage/kubernetes@20260119-020000

# If complete data loss: restore from Velero backup
velero restore create --from-backup media-backup
```

**RTO**: 2 hours
**RPO**: 24 hours (depends on snapshot frequency)

### Scenario 5: Complete Cluster Loss

**Detection**: All nodes down, cluster unresponsive

**Recovery**:

**Prerequisites**:
- Git repository accessible
- Proxmox accessible
- TrueNAS backups accessible

**Procedure**:

```bash
# 1. Clone infrastructure repo
git clone https://github.com/username/homelab.git
cd homelab

# 2. Rebuild Talos cluster
cd terragrunt/environments/homelab/talos-cluster
terragrunt destroy  # Clean up old resources
terragrunt apply

# 3. Restore etcd backup
talosctl -n <cp-node-ip> etcd restore /path/to/etcd-backup.db

# 4. Wait for cluster ready
kubectl get nodes --watch

# 5. ArgoCD auto-syncs from Git
# Or manually bootstrap:
cd terragrunt/environments/homelab/gitops-bootstrap
terragrunt apply

# 6. Restore PV data from Velero
velero restore create --from-backup latest-backup

# 7. Verify all applications
kubectl get applications -n argocd
kubectl get pods -A
```

**RTO**: 4 hours
**RPO**: 24 hours

### Scenario 6: Complete Homelab Loss

**Detection**: Fire, flood, theft, or other catastrophic event

**Recovery**:

**Prerequisites**:
- Off-site backups accessible (cloud storage)
- New hardware available
- Git repository accessible

**Procedure**:

```bash
# 1. Provision new hardware
# Install Proxmox on bare metal
# See hardware-setup.md

# 2. Configure Proxmox
cd homelab/ansible
ansible-playbook -i inventory/hosts.yml playbooks/site.yml

# 3. Provision infrastructure
cd terragrunt/environments/homelab
terragrunt run-all apply

# 4. Restore TrueNAS configuration
# Upload config file via TrueNAS UI

# 5. Restore data from cloud backups
rclone copy b2:homelab-backups /mnt/storage/

# 6. Bootstrap Kubernetes
cd talos-cluster
terragrunt apply

# 7. Restore applications via ArgoCD
kubectl get applications -n argocd --watch
```

**RTO**: 8 hours (assumes hardware available)
**RPO**: 24 hours (monthly cloud backup)

---

## Testing and Validation

### Backup Testing Schedule

| Test | Frequency | Procedure |
|------|-----------|-----------|
| Pod recovery | Weekly | Delete random pod, verify auto-restart |
| PVC restore | Monthly | Restore PVC from Velero backup to test namespace |
| etcd restore | Quarterly | Restore etcd to test cluster |
| Full cluster rebuild | Annually | Rebuild dev cluster from scratch |

### Validation Checklist

After any restore operation:

- [ ] All nodes in Ready state
- [ ] All pods in Running state
- [ ] All PVCs bound
- [ ] All Ingress resources have IPs
- [ ] DNS resolution working
- [ ] TLS certificates valid
- [ ] Application functionality verified
- [ ] Monitoring dashboards accessible
- [ ] Backup jobs running

### Test Restore Procedure

**Create Test Namespace**:

```bash
# Create test namespace
kubectl create namespace test-restore

# Restore backup to test namespace
velero restore create test-restore \
  --from-backup media-backup \
  --namespace-mappings media:test-restore

# Verify restore
kubectl get pods -n test-restore

# Cleanup
kubectl delete namespace test-restore
```

---

## Automation

### Backup Automation Scripts

**Daily Backup Script**:

```bash
#!/bin/bash
# /usr/local/bin/daily-backup.sh

set -euo pipefail

BACKUP_DATE=$(date +%Y%m%d)
BACKUP_DIR="/mnt/backups/daily/${BACKUP_DATE}"
mkdir -p "${BACKUP_DIR}"

# Backup etcd
echo "Backing up etcd..."
talosctl -n 172.16.100.51 etcd snapshot "${BACKUP_DIR}/etcd-${BACKUP_DATE}.db"

# Backup Kubernetes resources
echo "Backing up Kubernetes resources..."
kubectl get all -A -o yaml > "${BACKUP_DIR}/k8s-resources-${BACKUP_DATE}.yaml"

# Backup with Velero
echo "Running Velero backup..."
velero backup create daily-${BACKUP_DATE} --wait

# Sync to cloud storage
echo "Syncing to cloud..."
rclone sync /mnt/backups/daily b2:homelab-backups/daily

# Cleanup old backups (keep 7 days)
find /mnt/backups/daily -type d -mtime +7 -exec rm -rf {} +

echo "Backup completed: ${BACKUP_DATE}"
```

**Cron Schedule**:

```bash
# /etc/cron.d/homelab-backup
0 2 * * * root /usr/local/bin/daily-backup.sh >> /var/log/homelab-backup.log 2>&1
```

### Monitoring Backups

**Prometheus Alerts**:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: backup-alerts
  namespace: monitoring
spec:
  groups:
    - name: backups
      interval: 30s
      rules:
        - alert: VeleroBackupFailed
          expr: velero_backup_failure_total > 0
          for: 5m
          annotations:
            summary: "Velero backup failed"
            description: "Velero backup {{ $labels.backup }} failed"

        - alert: NoBackupIn24Hours
          expr: time() - velero_backup_success_time > 86400
          for: 1h
          annotations:
            summary: "No successful backup in 24 hours"
            description: "Last successful backup was {{ $value }}s ago"
```

---

## Troubleshooting

### Backup Failures

**Velero Backup Stuck**:

```bash
# Check Velero logs
kubectl -n velero logs deployment/velero

# Describe backup
velero backup describe <backup-name> --details

# Delete stuck backup
velero backup delete <backup-name> --confirm
```

**ZFS Snapshot Failed**:

```bash
# Check ZFS status
zpool status

# Check space
zfs list -o space

# Destroy old snapshots
zfs list -t snapshot
zfs destroy storage/kubernetes@old-snapshot
```

### Restore Failures

**PVC Not Restoring**:

```bash
# Check storage class exists
kubectl get storageclass

# Check CSI driver is running
kubectl -n democratic-csi get pods

# Manually create PVC if needed
kubectl apply -f pvc.yaml
```

**Application Not Starting After Restore**:

```bash
# Check pod events
kubectl describe pod -n media plex-xxx

# Check PVC binding
kubectl get pvc -n media

# Check resource constraints
kubectl top pods -n media
```

---

## References

### Tools

- [Velero Documentation](https://velero.io/docs/)
- [ZFS Administration Guide](https://openzfs.github.io/openzfs-docs/)
- [Proxmox Backup Server](https://pbs.proxmox.com/docs/)
- [rclone Documentation](https://rclone.org/docs/)

### Best Practices

- [Kubernetes Disaster Recovery](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/#backing-up-an-etcd-cluster)
- [3-2-1 Backup Rule](https://www.backblaze.com/blog/the-3-2-1-backup-strategy/)
- [ZFS Best Practices](https://wiki.archlinux.org/title/ZFS#Best_practices)

### Related Documentation

- [architecture.md](./architecture.md) - Architecture overview
- [runbooks/proxmox-recovery.md](./runbooks/proxmox-recovery.md) - Proxmox-specific recovery
- [runbooks/talos-upgrade.md](./runbooks/talos-upgrade.md) - Talos cluster recovery
- [runbooks/truenas-maintenance.md](./runbooks/truenas-maintenance.md) - TrueNAS backup procedures

---

**Last Updated**: 2026-01-19
**Version**: 1.0
**Maintainer**: homelab team
