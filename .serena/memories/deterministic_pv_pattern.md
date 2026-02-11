# Deterministic PV Pattern for GitOps Workloads

## Requirement
All application workloads with persistent storage MUST use **deterministic static PV+PVC pairs** so that:
- TrueNAS zvol/dataset names are human-readable and match the PVC name
- After cluster recreation, ArgoCD re-creates the same PV+PVC, re-binding to existing TrueNAS storage
- No data loss on cluster rebuild

## Naming Convention
| Layer | Pattern | Example |
|-------|---------|---------|
| PV name | `<pvc-name>-pv` | `sonarr-config-pv` |
| PVC name | `<pvc-name>` | `sonarr-config` |
| volumeHandle | `<pvc-name>` | `sonarr-config` |
| TrueNAS zvol (iSCSI) | `csi-<pvc-name>-homelab` | `csi-sonarr-config-homelab` |
| TrueNAS IQN | `iqn.2005-10.org.freenas.ctl:csi-<pvc-name>-homelab` | |
| TrueNAS dataset (NFS) | `csi-<pvc-name>-homelab` | `csi-prometheus-grafana-homelab` |

## Chart Pattern
Each app gets an individual `-config` chart under `charts/`:
```
charts/<app>-config/
├── Chart.yaml
├── templates/
│   ├── persistent-volume.yaml    # Static PV + PVC
│   └── secret.yaml               # OnePasswordItem (if needed)
├── values.yaml
└── values-homelab.yaml
```

### Template Pattern (persistent-volume.yaml)
Uses `range .Values.volumes` to support multiple PV+PVC pairs per chart (e.g., mosquitto has config + data).

### Sync Waves
- Config chart deploys ONE wave before the app itself
- Example: plex-config at wave 11, plex at wave 12

## DO NOT use stablePVCs in values-homelab.yaml
The old stablePVCs pattern is deprecated. It only creates PVCs (not PVs), resulting in random UUID-based names.

## Ansible Pre-provisioning
TrueNAS resources (zvols, iSCSI targets/extents, NFS datasets) are pre-created via Ansible.

## TrueNAS Connection Details
- Host: 172.16.100.150
- iSCSI portal: 172.16.100.150:3260
- IQN prefix: iqn.2005-10.org.freenas.ctl
- iSCSI naming: namePrefix=csi-, nameSuffix=-homelab
- API key: op://homelab/truenas-api-key/credential

## Democratic-CSI Driver Details
| Storage Class | Driver | Pool | Type |
|--------------|--------|------|------|
| democratic-csi-iscsi | org.democratic-csi.iscsi | ssd/iscsi | iSCSI SSD |
| democratic-csi-iscsi-hdd | org.democratic-csi.iscsi-hdd | hdd/iscsi | iSCSI HDD |
| democratic-csi-nfs | org.democratic-csi.nfs | NFS datasets | NFS |
| democratic-csi-ssd | org.democratic-csi.nfs-ssd | NFS SSD | NFS SSD |
