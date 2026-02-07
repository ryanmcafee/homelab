# Plan: SSD Storage Class + TrueNAS User/Permission Management

## Overview

Add SSD-backed NFS storage support for high-performance Kubernetes workloads via democratic-CSI, provision TrueNAS users/groups, configure proper ownership/permissions, and update Plex to use SSD storage for its config/metadata.

## Prerequisites

- The `ssd` ZFS pool already exists on TrueNAS
- TrueNAS API key available via 1Password

---

## Part 1: Ansible - TrueNAS Users & Groups

### 1.1 New task: `create_group.yml`
**File:** `ansible/roles/truenas_storage/tasks/create_group.yml`

Creates a TrueNAS group via the API (`/api/v2.0/group`). Checks if group exists first, creates if not.

### 1.2 New task: `create_user.yml`
**File:** `ansible/roles/truenas_storage/tasks/create_user.yml`

Creates a TrueNAS user via the API (`/api/v2.0/user`). Checks if user exists first, creates if not. Accepts: username, full_name, group, password, home_dir, shell.

### 1.3 New variables in defaults
**File:** `ansible/roles/truenas_storage/defaults/main.yml`

```yaml
# User/Group Configuration
truenas_groups:
  - name: users
    gid: 100  # Standard 'users' GID
    smb: true

truenas_users:
  - name: rmcafee
    full_name: "Ryan McAfee"
    group: users
    shell: /usr/bin/bash
    smb: true
  - name: plex
    full_name: "Plex Media Server"
    group: users
    shell: /usr/sbin/nologin
    smb: false
```

### 1.4 Wire into main.yml
**File:** `ansible/roles/truenas_storage/tasks/main.yml`

Add group and user creation tasks after pool creation but before dataset creation:
```yaml
- name: Include group creation
  include_tasks: create_group.yml
  loop: "{{ truenas_groups }}"
  loop_control:
    loop_var: group

- name: Include user creation
  include_tasks: create_user.yml
  loop: "{{ truenas_users }}"
  loop_control:
    loop_var: user
```

---

## Part 2: Ansible - SSD Dataset & Shares

### 2.1 New variables in defaults
**File:** `ansible/roles/truenas_storage/defaults/main.yml`

```yaml
# SSD Pool Configuration
truenas_ssd_pool_name: ssd

# SSD Kubernetes Dataset
truenas_ssd_k8s_dataset: "{{ truenas_ssd_pool_name }}/k8s"
truenas_ssd_k8s_quota: 500G
truenas_ssd_k8s_compression: lz4

# SSD Kubernetes Snapshots Dataset
truenas_ssd_k8s_snapshots_dataset: "{{ truenas_ssd_pool_name }}/k8s-snapshots"
truenas_ssd_k8s_snapshots_quota: 100G
truenas_ssd_k8s_snapshots_compression: lz4
```

### 2.2 Wire into main.yml
**File:** `ansible/roles/truenas_storage/tasks/main.yml`

After existing K8s dataset creation, add SSD dataset creation using existing `create_dataset.yml` task:
```yaml
- name: Include SSD K8s dataset creation
  include_tasks: create_dataset.yml
  vars:
    dataset_name: "{{ truenas_ssd_k8s_dataset }}"
    dataset_quota: "{{ truenas_ssd_k8s_quota }}"
    dataset_compression: "{{ truenas_ssd_k8s_compression }}"
    dataset_comments: "SSD Kubernetes persistent volumes (high performance)"

- name: Include SSD K8s snapshots dataset creation
  include_tasks: create_dataset.yml
  vars:
    dataset_name: "{{ truenas_ssd_k8s_snapshots_dataset }}"
    dataset_quota: "{{ truenas_ssd_k8s_snapshots_quota }}"
    dataset_compression: "{{ truenas_ssd_k8s_snapshots_compression }}"
    dataset_comments: "SSD Kubernetes snapshots for democratic-csi"
```

### 2.3 NFS share for ssd/k8s
**File:** `ansible/roles/truenas_storage/tasks/main.yml`

Add after existing NFS share creation:
```yaml
- name: Include NFS share creation for SSD Kubernetes
  include_tasks: create_nfs_share.yml
  vars:
    nfs_path: "/mnt/{{ truenas_ssd_k8s_dataset }}"
    nfs_comment: "SSD Kubernetes NFS storage (high performance)"
    nfs_networks: "{{ truenas_nfs_allowed_networks }}"
    nfs_maproot_user: "{{ truenas_nfs_maproot_user }}"
    nfs_maproot_group: "{{ truenas_nfs_maproot_group }}"
```

### 2.4 SMB share for ssd/k8s
**File:** `ansible/roles/truenas_storage/tasks/main.yml`

Add after existing SMB share creation:
```yaml
- name: Include SMB share creation for SSD Kubernetes
  include_tasks: create_smb_share.yml
  vars:
    smb_path: "/mnt/{{ truenas_ssd_k8s_dataset }}"
    smb_name: "ssd-k8s"
    smb_comment: "SSD Kubernetes storage"
    smb_browsable: "{{ truenas_smb_browsable | default(true) }}"
    smb_readonly: "{{ truenas_smb_readonly | default(false) }}"
    smb_guest_ok: "{{ truenas_smb_guest_ok | default(false) }}"
  when: truenas_smb_enabled | default(false)
```

---

## Part 3: Ansible - Dataset Permissions

### 3.1 New task: `set_dataset_permissions.yml`
**File:** `ansible/roles/truenas_storage/tasks/set_dataset_permissions.yml`

Sets ownership and permissions on a dataset via the TrueNAS API (`/api/v2.0/filesystem/setperm`):
- Accepts: dataset_path, perm_user, perm_group, perm_mode, perm_recursive

### 3.2 Wire into main.yml
**File:** `ansible/roles/truenas_storage/tasks/main.yml`

After all dataset and share creation (before the summary):
```yaml
# Set permissions on all datasets
- name: Set permissions on storage pool datasets
  include_tasks: set_dataset_permissions.yml
  loop:
    - "{{ truenas_k8s_dataset }}"
    - "{{ truenas_k8s_snapshots_dataset }}"
    - "{{ truenas_ssd_k8s_dataset }}"
    - "{{ truenas_ssd_k8s_snapshots_dataset }}"
  loop_control:
    loop_var: dataset_path
  vars:
    perm_user: "{{ truenas_dataset_owner_user }}"
    perm_group: "{{ truenas_dataset_owner_group }}"
    perm_mode: "{{ truenas_dataset_permissions_mode }}"
    perm_recursive: true

- name: Set permissions on media datasets
  include_tasks: set_dataset_permissions.yml
  loop: "{{ truenas_media_datasets | map(attribute='name') | list }}"
  loop_control:
    loop_var: dataset_path
  vars:
    perm_user: "{{ truenas_dataset_owner_user }}"
    perm_group: "{{ truenas_dataset_owner_group }}"
    perm_mode: "{{ truenas_dataset_permissions_mode }}"
    perm_recursive: true
```

### 3.3 New variables in defaults
**File:** `ansible/roles/truenas_storage/defaults/main.yml`

```yaml
# Dataset Permissions
truenas_dataset_owner_user: rmcafee
truenas_dataset_owner_group: users
truenas_dataset_permissions_mode: "770"
```

---

## Part 4: Democratic-CSI SSD Deployment (Kubernetes)

### 4.1 New template: `democratic-csi-ssd.yaml`
**File:** `charts/addons/templates/democratic-csi-ssd.yaml`

A new ArgoCD Application (separate from existing democratic-csi) that:
- Uses the same Helm chart (`democratic-csi` v0.14.6)
- Deploys in the same `democratic-csi` namespace (reuses the `truenas-api-key` secret)
- Has a unique CSI driver name: `org.democratic-csi.nfs-ssd`
- Points to `ssd/k8s` as the parent dataset
- Points to `ssd/k8s-snapshots` as the detached snapshots dataset
- Creates a `democratic-csi-ssd` storage class (NOT default)
- Same NFS share host and allowed networks
- Sync Wave: **2** (same as existing democratic-csi)
- `datasetPermissionsMode: "0770"`, user/group `0`/`0` (root - democratic-CSI managed)

No separate democratic-csi-config needed since the existing one already creates the `truenas-api-key` secret in the `democratic-csi` namespace.

### 4.2 Values additions
**File:** `charts/addons/values.yaml`

Add new `democratic-csi-ssd` section (disabled by default, parallel to existing `democratic-csi`):
```yaml
democratic-csi-ssd:
  enabled: false
  namespace: democratic-csi
  chart:
    name: democratic-csi
    repo: https://democratic-csi.github.io/charts/
    version: 0.14.6
  driver: freenas-nfs
  truenas:
    endpoint: https://truenas.ryanmcafee.com
    allowInsecure: false
    apiKey: ""
  nfs:
    shareHost: truenas.ryanmcafee.com
    shareAllow: 172.16.100.0/24
    parent: ssd/k8s
  storageClasses:
    - name: democratic-csi-ssd
      defaultClass: false
      reclaimPolicy: Retain
      volumeBindingMode: Immediate
      allowVolumeExpansion: true
      parameters:
        fsType: nfs
  resources:
    controller:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
    node:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
```

**File:** `charts/addons/values-homelab.yaml`

Add homelab-specific overrides (enabled, IP-based endpoint, `freenas-api-nfs` driver):
```yaml
democratic-csi-ssd:
  enabled: true
  namespace: democratic-csi
  chart:
    name: democratic-csi
    repo: https://democratic-csi.github.io/charts/
    version: 0.14.6
  driver: freenas-api-nfs
  truenas:
    endpoint: https://172.16.100.150
    allowInsecure: true
    apiKey: ""
    onePasswordItemPath: vaults/homelab/items/truenas
  nfs:
    shareHost: 172.16.100.150
    shareAllow: 172.16.100.0/24
    parent: ssd/k8s
  storageClasses:
    - name: democratic-csi-ssd
      defaultClass: false
      reclaimPolicy: Retain
      volumeBindingMode: Immediate
      allowVolumeExpansion: true
      parameters:
        fsType: nfs
  resources:
    controller:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
    node:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
```

---

## Part 5: Plex Configuration Update

### 5.1 Update Plex config storage class
**File:** `charts/applications/values-homelab.yaml`

Change Plex's config PVC to use the SSD storage class:
```yaml
plex:
  pms:
    storageClassName: democratic-csi-ssd  # was: democratic-csi-nfs
  persistence:
    config:
      storageClass: democratic-csi-ssd    # was: democratic-csi-nfs
```

Media NFS mounts (movies, tv, music, pictures) remain unchanged - they continue using direct NFS volumes from the `storage` pool.

### 5.2 Plex Data Migration (storage PVC -> SSD PVC)

Migrate existing Plex config/metadata from the HDD-backed `democratic-csi-nfs` PVC to the new SSD-backed `democratic-csi-ssd` PVC.

**Step 1: Scale down Plex**
```bash
kubectl -n media scale deployment plex --replicas=0
```

**Step 2: Identify the existing PV and NFS path**
```bash
# Get the PVC and bound PV
kubectl -n media get pvc plex-pms-config -o jsonpath='{.spec.volumeName}'
# Get the NFS path of the existing PV
kubectl get pv <pv-name> -o jsonpath='{.spec.nfs.path}'
# This will be something like /mnt/storage/k8s/pvc-<uuid>
```

**Step 3: Create a temporary SSD PVC for migration**
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: plex-pms-config-ssd
  namespace: media
spec:
  storageClassName: democratic-csi-ssd
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
```

**Step 4: Copy data using a migration pod**
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: plex-migrate
  namespace: media
spec:
  containers:
    - name: migrate
      image: alpine:latest
      command: ["sh", "-c", "apk add rsync && rsync -avP /source/ /dest/ && echo 'Migration complete'"]
      volumeMounts:
        - name: source
          mountPath: /source
        - name: dest
          mountPath: /dest
  volumes:
    - name: source
      persistentVolumeClaim:
        claimName: plex-pms-config
    - name: dest
      persistentVolumeClaim:
        claimName: plex-pms-config-ssd
  restartPolicy: Never
```

**Step 5: Verify migration**
```bash
kubectl -n media logs plex-migrate -f
# Wait for "Migration complete"
```

**Step 6: Update Plex values to use SSD storage class** (Part 5.1 above)
- Update `charts/applications/values-homelab.yaml` with `democratic-csi-ssd`
- Delete the old PVC: `kubectl -n media delete pvc plex-pms-config`
- Rename the new PVC: delete and recreate with the correct name, or update the Plex deployment to reference the new PVC name

**Step 7: Clean up**
```bash
kubectl -n media delete pod plex-migrate
# Scale Plex back up (ArgoCD will handle this automatically after sync)
```

**Alternative approach:** If downtime is acceptable, simply:
1. Scale down Plex
2. Copy data directly between NFS paths on TrueNAS: `rsync -avP /mnt/storage/k8s/pvc-<uuid>/ /mnt/ssd/k8s/pvc-<new-uuid>/`
3. Update values and let ArgoCD recreate with new storage class

---

## Implementation Status

### Completed

| File | Action | Description |
|------|--------|-------------|
| `ansible/roles/truenas_storage/defaults/main.yml` | **Edit** | Added SSD dataset vars, user/group vars, permission vars |
| `ansible/roles/truenas_storage/tasks/main.yml` | **Edit** | Wired in new tasks for groups, users, SSD datasets, SSD shares, permissions |
| `ansible/roles/truenas_storage/tasks/create_group.yml` | **New** | Create TrueNAS group via API |
| `ansible/roles/truenas_storage/tasks/create_user.yml` | **New** | Create TrueNAS user via API |
| `ansible/roles/truenas_storage/tasks/set_dataset_permissions.yml` | **New** | Set ownership/permissions on datasets |
| `charts/addons/templates/democratic-csi-ssd.yaml` | **New** | ArgoCD Application for SSD democratic-CSI |
| `charts/addons/values.yaml` | **Edit** | Added `democratic-csi-ssd` base values (disabled by default) |
| `charts/addons/values-homelab.yaml` | **Edit** | Added `democratic-csi-ssd` homelab overrides (enabled) |
| `charts/applications/values-homelab.yaml` | **Edit** | Updated Plex config storage class to `democratic-csi-ssd` |

### Not Yet Done (Manual Steps)

| Step | Description |
|------|-------------|
| Plex data migration | Follow Part 5.2 migration steps after SSD storage class is operational |

---

## Verification

1. **Helm lint**: `task chart:lint` - All charts lint clean
2. **Template rendering**: `helm template addons charts/addons -f charts/addons/values.yaml -f charts/addons/values-homelab.yaml -s templates/democratic-csi-ssd.yaml` - Renders correctly
3. **Full template render**: Both addons and applications charts render without errors
4. **Ansible**: Run `ansible-playbook -i inventory playbooks/truenas-setup.yml --check` to verify tasks
5. **ArgoCD sync**: After merge to main, verify `democratic-csi-ssd` app appears and syncs
6. **Storage class**: `kubectl get sc` should show both `democratic-csi-nfs` (default) and `democratic-csi-ssd`
7. **Test PVC**: Create a test PVC with `storageClassName: democratic-csi-ssd` to verify provisioning
8. **Plex migration**: Follow Part 5.2 migration steps, then verify Plex starts and loads its database from SSD-backed storage
