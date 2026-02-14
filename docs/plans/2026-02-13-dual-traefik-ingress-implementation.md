# Dual Traefik Ingress Controller Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the single Traefik ingress controller into external (Plex-facing) and internal (all other apps) instances with separate IngressClasses, LoadBalancer IPs, and ArgoCD applications.

**Architecture:** Two independent Traefik deployments in the same namespace (`traefik`), each with its own IngressClass (`external` / `internal`), LoadBalancer Service, and ArgoCD application trio (dependencies → main → config). The external instance keeps OIDC, static IP, and port forwarding. The internal instance is a lean Traefik with dynamic IP.

**Tech Stack:** Helm templates, ArgoCD Applications, Traefik Helm chart v39.0.0, Cilium LB IPAM, Go templates (configuration system)

**Design Doc:** `docs/plans/2026-02-13-dual-traefik-ingress-design.md`

---

## Task 1: Configuration Schema — Add New Ingress Class Variables

Replace the single `INGRESS_CLASS` with two variables for external and internal ingress classes.

**Files:**
- Modify: `configuration/schema/kubernetes.schema.yaml` (line 30-33)
- Modify: `configuration/environments/defaults.yaml` (line 15)
- Modify: `configuration/schema/network.schema.yaml` (add `TRAEFIK_INTERNAL_HOSTNAME`)

**Step 1: Update kubernetes.schema.yaml**

Replace the `INGRESS_CLASS` entry (lines 30-33) with two entries:

```yaml
  INGRESS_CLASS_EXTERNAL:
    description: IngressClass name for externally-facing services
    required: true
    default: "external"

  INGRESS_CLASS_INTERNAL:
    description: IngressClass name for internal services
    required: true
    default: "internal"
```

**Step 2: Update defaults.yaml**

Replace `INGRESS_CLASS: traefik` (line 15) with:

```yaml
INGRESS_CLASS_EXTERNAL: external
INGRESS_CLASS_INTERNAL: internal
```

**Step 3: Add TRAEFIK_INTERNAL_HOSTNAME to network.schema.yaml**

After the existing `TRAEFIK_HOSTNAME` entry (lines 110-112), add:

```yaml
  TRAEFIK_INTERNAL_HOSTNAME:
    description: Traefik internal dashboard hostname
    const: "traefik-internal.{{.DOMAIN}}"
```

**Step 4: Validate schema**

Run: `task config:validate`
Expected: PASS — no errors

**Step 5: Commit**

```bash
git add configuration/schema/kubernetes.schema.yaml configuration/environments/defaults.yaml configuration/schema/network.schema.yaml
git commit -m "feat(config): split INGRESS_CLASS into external and internal"
```

---

## Task 2: Rename Existing Helper Charts

Rename `charts/traefik-dependencies/` → `charts/traefik-external-dependencies/` and `charts/traefik-config/` → `charts/traefik-external-config/`. No content changes needed yet.

**Files:**
- Rename: `charts/traefik-dependencies/` → `charts/traefik-external-dependencies/`
- Rename: `charts/traefik-config/` → `charts/traefik-external-config/`

**Step 1: Rename traefik-dependencies**

```bash
git mv charts/traefik-dependencies charts/traefik-external-dependencies
```

**Step 2: Update Chart.yaml name**

In `charts/traefik-external-dependencies/Chart.yaml`, change:
```yaml
name: traefik-external-dependencies
description: Pre-requisite resources for external Traefik (secrets, OnePasswordItems)
```

**Step 3: Rename traefik-config**

```bash
git mv charts/traefik-config charts/traefik-external-config
```

**Step 4: Update Chart.yaml name**

In `charts/traefik-external-config/Chart.yaml`, change:
```yaml
name: traefik-external-config
description: CRD-dependent configuration for external Traefik (dashboard, OIDC middlewares, certificates)
```

**Step 5: Commit**

```bash
git add charts/traefik-external-dependencies charts/traefik-external-config
git commit -m "refactor(charts): rename traefik helper charts to traefik-external-*"
```

---

## Task 3: Create Internal Helper Charts

Create `charts/traefik-internal-dependencies/` (minimal) and `charts/traefik-internal-config/` (dashboard only, no OIDC).

**Files:**
- Create: `charts/traefik-internal-dependencies/Chart.yaml`
- Create: `charts/traefik-internal-dependencies/values.yaml`
- Create: `charts/traefik-internal-dependencies/values-homelab.yaml`
- Create: `charts/traefik-internal-dependencies/templates/secrets.yaml`
- Create: `charts/traefik-internal-config/Chart.yaml`
- Create: `charts/traefik-internal-config/values.yaml`
- Create: `charts/traefik-internal-config/values-homelab.yaml`
- Create: `charts/traefik-internal-config/templates/dashboard.yaml`

**Step 1: Create traefik-internal-dependencies chart**

`charts/traefik-internal-dependencies/Chart.yaml`:
```yaml
apiVersion: v2
name: traefik-internal-dependencies
description: Pre-requisite resources for internal Traefik (secrets, OnePasswordItems)
type: application
version: 1.0.0
appVersion: "1.0"
```

`charts/traefik-internal-dependencies/values.yaml`:
```yaml
# traefik-internal-dependencies values
# Currently no secrets needed for internal Traefik

namespace: traefik
```

`charts/traefik-internal-dependencies/values-homelab.yaml`:
```yaml
# traefik-internal-dependencies homelab values

namespace: traefik
```

`charts/traefik-internal-dependencies/templates/secrets.yaml`:
```yaml
# No secrets required for internal Traefik currently.
# This chart exists as a placeholder for future secret needs
# and to maintain the consistent 3-app pattern
# (dependencies → main → config).
```

**Step 2: Create traefik-internal-config chart**

`charts/traefik-internal-config/Chart.yaml`:
```yaml
apiVersion: v2
name: traefik-internal-config
description: CRD-dependent configuration for internal Traefik (dashboard, certificates)
type: application
version: 1.0.0
appVersion: "1.0"
```

`charts/traefik-internal-config/values.yaml`:
```yaml
# traefik-internal-config values
# CRD-dependent resources that deploy AFTER internal Traefik

global:
  domain: example.com

namespace: traefik

# Dashboard configuration
dashboard:
  enabled: true
  host: traefik-internal.example.com
```

`charts/traefik-internal-config/values-homelab.yaml`:
```yaml
# traefik-internal-config homelab values

global:
  domain: ryanmcafee.com

namespace: traefik

dashboard:
  enabled: true
  host: traefik-internal.ryanmcafee.com
```

`charts/traefik-internal-config/templates/dashboard.yaml`:
```yaml
{{- if .Values.dashboard.enabled }}
---
apiVersion: externaldns.k8s.io/v1alpha1
kind: DNSEndpoint
metadata:
  name: traefik-internal-dashboard
  namespace: {{ .Values.namespace }}
spec:
  endpoints:
    - dnsName: {{ .Values.dashboard.host }}
      recordType: A
      targets:
        - "{{ .Values.dashboard.staticIP }}"
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: traefik-internal-dashboard-tls
  namespace: {{ .Values.namespace }}
spec:
  secretName: traefik-internal-dashboard-tls
  issuerRef:
    name: letsencrypt
    kind: ClusterIssuer
  dnsNames:
    - {{ .Values.dashboard.host }}
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: internal-dashboard-redirect-slash
  namespace: {{ .Values.namespace }}
spec:
  redirectRegex:
    regex: ^(https?://[^/]+/dashboard)$
    replacement: ${1}/
    permanent: true
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: traefik-internal-dashboard-redirect
  namespace: {{ .Values.namespace }}
spec:
  entryPoints:
    - websecure
  routes:
    - kind: Rule
      match: Host(`{{ .Values.dashboard.host }}`) && Path(`/dashboard`)
      middlewares:
        - name: internal-dashboard-redirect-slash
      services:
        - kind: TraefikService
          name: noop@internal
  tls:
    secretName: traefik-internal-dashboard-tls
{{- end }}
```

**Important note on dashboard.yaml:** The `DNSEndpoint` uses `dashboard.staticIP` but internal Traefik has a dynamic IP. This is a known limitation — the DNSEndpoint needs a target IP. There are two options:

1. Use the Traefik Service's LoadBalancer IP (requires manual update or external-dns ingress source instead of DNSEndpoint)
2. Let external-dns pick up the ingress annotation `external-dns.alpha.kubernetes.io/hostname` from the IngressRoute

Since Traefik's built-in IngressRoute won't have standard ingress annotations, we should add `staticIP` to the internal config values but leave it blank initially. The dashboard DNS record can be updated once the internal LB IP is assigned. Alternatively, we can omit the DNSEndpoint and rely on the dashboard being accessible via the LB IP directly.

**Revised approach:** Remove the DNSEndpoint from the internal dashboard template (since IP is dynamic), and the dashboard will be accessible via the dynamically assigned LB IP. If a DNS record is needed later, it can be added manually or via a different mechanism.

Updated `charts/traefik-internal-config/templates/dashboard.yaml` — remove the DNSEndpoint block:

```yaml
{{- if .Values.dashboard.enabled }}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: traefik-internal-dashboard-tls
  namespace: {{ .Values.namespace }}
spec:
  secretName: traefik-internal-dashboard-tls
  issuerRef:
    name: letsencrypt
    kind: ClusterIssuer
  dnsNames:
    - {{ .Values.dashboard.host }}
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: internal-dashboard-redirect-slash
  namespace: {{ .Values.namespace }}
spec:
  redirectRegex:
    regex: ^(https?://[^/]+/dashboard)$
    replacement: ${1}/
    permanent: true
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: traefik-internal-dashboard-redirect
  namespace: {{ .Values.namespace }}
spec:
  entryPoints:
    - websecure
  routes:
    - kind: Rule
      match: Host(`{{ .Values.dashboard.host }}`) && Path(`/dashboard`)
      middlewares:
        - name: internal-dashboard-redirect-slash
      services:
        - kind: TraefikService
          name: noop@internal
  tls:
    secretName: traefik-internal-dashboard-tls
{{- end }}
```

**Step 3: Commit**

```bash
git add charts/traefik-internal-dependencies charts/traefik-internal-config
git commit -m "feat(charts): add traefik-internal-dependencies and traefik-internal-config helper charts"
```

---

## Task 4: Create traefik-external.yaml Addons Template

Replace the existing `charts/addons/templates/traefik.yaml` with `traefik-external.yaml`. This is the external Traefik ArgoCD application template — functionally identical to the current one but with renamed values keys (`traefikExternal.*`) and renamed ArgoCD application names.

**Files:**
- Delete: `charts/addons/templates/traefik.yaml`
- Create: `charts/addons/templates/traefik-external.yaml`

**Step 1: Delete old template**

```bash
git rm charts/addons/templates/traefik.yaml
```

**Step 2: Create traefik-external.yaml**

Create `charts/addons/templates/traefik-external.yaml` with the following content. Key differences from original:
- All `.Values.traefik.*` → `.Values.traefikExternal.*`
- ArgoCD app name `traefik-dependencies` → `traefik-external-dependencies`
- ArgoCD app name `traefik` → `traefik-external`
- ArgoCD app name `traefik-config` → `traefik-external-config`
- Source path `charts/traefik-dependencies` → `charts/traefik-external-dependencies`
- Source path `charts/traefik-config` → `charts/traefik-external-config`
- Helm `releaseName: traefik` → `releaseName: traefik-external`
- Add `ingressClass.name: external` and `ingressClass.isDefaultClass: false` in Helm values

```yaml
{{- if .Values.traefikExternal.enabled }}
---
# Namespace for Traefik ingress controllers
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.traefikExternal.namespace }}
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
---
# Dependencies Application: deploys secrets and OnePasswordItems before external traefik
# Wave 5: After external-dns (wave 4) so OnePasswordItem CRDs are available
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik-external-dependencies
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "5"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ .Values.global.repoUrl }}
    targetRevision: {{ .Values.global.targetRevision }}
    path: charts/traefik-external-dependencies
    helm:
      valueFiles:
        - values.yaml
        - values-{{ .Values.global.environment }}.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: traefik
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
      - SkipDryRunOnMissingResource=true
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik-external
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "6"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ .Values.traefikExternal.chart.repo }}
    chart: {{ .Values.traefikExternal.chart.name }}
    targetRevision: {{ .Values.traefikExternal.chart.version }}
    helm:
      releaseName: traefik-external
      values: |
        # IngressClass configuration
        ingressClass:
          name: external
          isDefaultClass: false

        deployment:
          replicas: {{ .Values.traefikExternal.deployment.replicas }}

        service:
          type: {{ .Values.traefikExternal.service.type }}
          {{- if .Values.traefikExternal.service.annotations }}
          annotations:
            {{- toYaml .Values.traefikExternal.service.annotations | nindent 12 }}
          {{- end }}
          {{- if .Values.traefikExternal.service.spec }}
          spec:
            {{- toYaml .Values.traefikExternal.service.spec | nindent 12 }}
          {{- end }}

        providers:
          kubernetesIngress:
            publishedService:
              enabled: true
            ingressClass: external
          kubernetesCRD:
            allowCrossNamespace: true
            ingressClass: external

        ports:
          web:
            port: {{ .Values.traefikExternal.ports.web.port }}
            exposedPort: {{ .Values.traefikExternal.ports.web.exposedPort | default 80 }}
            expose:
              default: {{ .Values.traefikExternal.ports.web.expose.default }}
            {{- if .Values.traefikExternal.ports.web.http }}
            http:
              {{- if .Values.traefikExternal.ports.web.http.redirections }}
              redirections:
                entryPoint:
                  to: {{ .Values.traefikExternal.ports.web.http.redirections.entryPoint.to }}
                  scheme: {{ .Values.traefikExternal.ports.web.http.redirections.entryPoint.scheme }}
                  permanent: {{ .Values.traefikExternal.ports.web.http.redirections.entryPoint.permanent }}
              {{- end }}
            {{- end }}
          websecure:
            port: {{ .Values.traefikExternal.ports.websecure.port }}
            exposedPort: {{ .Values.traefikExternal.ports.websecure.exposedPort | default 443 }}
            expose:
              default: {{ .Values.traefikExternal.ports.websecure.expose.default }}
            {{- if .Values.traefikExternal.ports.websecure.asDefault }}
            asDefault: {{ .Values.traefikExternal.ports.websecure.asDefault }}
            {{- end }}
            {{- if .Values.traefikExternal.ports.websecure.http }}
            http:
              tls:
                enabled: {{ .Values.traefikExternal.ports.websecure.http.tls.enabled }}
            {{- end }}
            {{- if .Values.traefikExternal.ports.websecure.transport }}
            transport:
              {{- toYaml .Values.traefikExternal.ports.websecure.transport | nindent 14 }}
            {{- end }}
          {{- if .Values.traefikExternal.ports.traefik }}
          traefik:
            port: {{ .Values.traefikExternal.ports.traefik.port }}
            expose:
              default: {{ .Values.traefikExternal.ports.traefik.expose.default }}
          {{- end }}

        {{- if .Values.traefikExternal.additionalArguments }}
        additionalArguments:
          {{- range .Values.traefikExternal.additionalArguments }}
          - {{ . }}
          {{- end }}
        {{- else }}
        additionalArguments: []
        {{- end }}

        {{- if .Values.traefikExternal.experimental }}
        experimental:
          {{- if .Values.traefikExternal.experimental.plugins }}
          plugins:
            {{- range $name, $plugin := .Values.traefikExternal.experimental.plugins }}
            {{ $name }}:
              moduleName: {{ $plugin.moduleName }}
              version: {{ $plugin.version }}
            {{- end }}
          {{- end }}
        {{- end }}

        env:
          {{- toYaml .Values.traefikExternal.env | nindent 10 }}

        {{- if .Values.traefikExternal.volumes }}
        volumes:
          {{- toYaml .Values.traefikExternal.volumes | nindent 10 }}
        {{- end }}

        certificatesResolvers: {}

        persistence:
          enabled: {{ .Values.traefikExternal.persistence.enabled }}
          {{- if .Values.traefikExternal.persistence.enabled }}
          storageClass: {{ .Values.traefikExternal.persistence.storageClass }}
          size: {{ .Values.traefikExternal.persistence.size }}
          {{- end }}

        ingressRoute:
          dashboard:
            enabled: {{ .Values.traefikExternal.ingressRoute.dashboard.enabled }}
            {{- if .Values.traefikExternal.ingressRoute.dashboard.enabled }}
            matchRule: {{ .Values.traefikExternal.ingressRoute.dashboard.matchRule }}
            entryPoints:
              {{- toYaml .Values.traefikExternal.ingressRoute.dashboard.entryPoints | nindent 14 }}
            {{- if .Values.traefikExternal.ingressRoute.dashboard.tls }}
            tls:
              secretName: {{ .Values.traefikExternal.ingressRoute.dashboard.tls.secretName }}
            {{- end }}
            {{- end }}

        resources:
          {{- toYaml .Values.traefikExternal.resources | nindent 10 }}

        {{- if .Values.traefikExternal.autoscaling.enabled }}
        autoscaling:
          enabled: true
          minReplicas: {{ .Values.traefikExternal.autoscaling.minReplicas }}
          maxReplicas: {{ .Values.traefikExternal.autoscaling.maxReplicas }}
          metrics:
            {{- toYaml .Values.traefikExternal.autoscaling.metrics | nindent 12 }}
        {{- end }}

  destination:
    server: https://kubernetes.default.svc
    namespace: {{ .Values.traefikExternal.namespace }}

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
      - ApplyOutOfSyncOnly=true
      - RespectIgnoreDifferences=true

  ignoreDifferences:
    - group: admissionregistration.k8s.io
      kind: ValidatingWebhookConfiguration
      jqPathExpressions:
        - .webhooks[].clientConfig.caBundle
{{- if and .Values.traefikExternal.oidc .Values.traefikExternal.oidc.enabled }}
---
# Redis for OIDC session storage (required for multi-replica Traefik)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oidc-redis
  namespace: {{ .Values.traefikExternal.namespace }}
  annotations:
    argocd.argoproj.io/sync-wave: "7"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oidc-redis
  template:
    metadata:
      labels:
        app: oidc-redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "128Mi"
              cpu: "100m"
---
apiVersion: v1
kind: Service
metadata:
  name: oidc-redis
  namespace: {{ .Values.traefikExternal.namespace }}
  annotations:
    argocd.argoproj.io/sync-wave: "7"
spec:
  selector:
    app: oidc-redis
  ports:
    - port: 6379
      targetPort: 6379
{{- end }}
---
# Config Application: deploys CRD-dependent resources
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik-external-config
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "8"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ .Values.global.repoUrl }}
    targetRevision: {{ .Values.global.targetRevision }}
    path: charts/traefik-external-config
    helm:
      valueFiles:
        - values.yaml
        - values-{{ .Values.global.environment }}.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: traefik
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
      - SkipDryRunOnMissingResource=true
{{- end }}
```

**Step 3: Commit**

```bash
git add charts/addons/templates/traefik-external.yaml
git rm charts/addons/templates/traefik.yaml
git commit -m "feat(charts): replace traefik.yaml template with traefik-external.yaml"
```

---

## Task 5: Create traefik-internal.yaml Addons Template

Create the internal Traefik ArgoCD application template. This is a simplified version — no OIDC, no Redis, no port forwarding, dynamic IP.

**Files:**
- Create: `charts/addons/templates/traefik-internal.yaml`

**Step 1: Create the template**

Create `charts/addons/templates/traefik-internal.yaml`:

```yaml
{{- if .Values.traefikInternal.enabled }}
---
# Dependencies Application: placeholder for future secret needs
# Wave 5: Maintains consistent pattern with external traefik
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik-internal-dependencies
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "5"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ .Values.global.repoUrl }}
    targetRevision: {{ .Values.global.targetRevision }}
    path: charts/traefik-internal-dependencies
    helm:
      valueFiles:
        - values.yaml
        - values-{{ .Values.global.environment }}.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: traefik
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
      - SkipDryRunOnMissingResource=true
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik-internal
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "6"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ .Values.traefikInternal.chart.repo }}
    chart: {{ .Values.traefikInternal.chart.name }}
    targetRevision: {{ .Values.traefikInternal.chart.version }}
    helm:
      releaseName: traefik-internal
      values: |
        # IngressClass configuration
        ingressClass:
          name: internal
          isDefaultClass: false

        deployment:
          replicas: {{ .Values.traefikInternal.deployment.replicas }}

        service:
          type: {{ .Values.traefikInternal.service.type }}
          {{- if .Values.traefikInternal.service.annotations }}
          annotations:
            {{- toYaml .Values.traefikInternal.service.annotations | nindent 12 }}
          {{- end }}
          {{- if .Values.traefikInternal.service.spec }}
          spec:
            {{- toYaml .Values.traefikInternal.service.spec | nindent 12 }}
          {{- end }}

        providers:
          kubernetesIngress:
            publishedService:
              enabled: true
            ingressClass: internal
          kubernetesCRD:
            allowCrossNamespace: true
            ingressClass: internal

        ports:
          web:
            port: {{ .Values.traefikInternal.ports.web.port }}
            exposedPort: {{ .Values.traefikInternal.ports.web.exposedPort | default 80 }}
            expose:
              default: {{ .Values.traefikInternal.ports.web.expose.default }}
            {{- if .Values.traefikInternal.ports.web.http }}
            http:
              {{- if .Values.traefikInternal.ports.web.http.redirections }}
              redirections:
                entryPoint:
                  to: {{ .Values.traefikInternal.ports.web.http.redirections.entryPoint.to }}
                  scheme: {{ .Values.traefikInternal.ports.web.http.redirections.entryPoint.scheme }}
                  permanent: {{ .Values.traefikInternal.ports.web.http.redirections.entryPoint.permanent }}
              {{- end }}
            {{- end }}
          websecure:
            port: {{ .Values.traefikInternal.ports.websecure.port }}
            exposedPort: {{ .Values.traefikInternal.ports.websecure.exposedPort | default 443 }}
            expose:
              default: {{ .Values.traefikInternal.ports.websecure.expose.default }}
            {{- if .Values.traefikInternal.ports.websecure.asDefault }}
            asDefault: {{ .Values.traefikInternal.ports.websecure.asDefault }}
            {{- end }}
            {{- if .Values.traefikInternal.ports.websecure.http }}
            http:
              tls:
                enabled: {{ .Values.traefikInternal.ports.websecure.http.tls.enabled }}
            {{- end }}
            {{- if .Values.traefikInternal.ports.websecure.transport }}
            transport:
              {{- toYaml .Values.traefikInternal.ports.websecure.transport | nindent 14 }}
            {{- end }}
          {{- if .Values.traefikInternal.ports.traefik }}
          traefik:
            port: {{ .Values.traefikInternal.ports.traefik.port }}
            expose:
              default: {{ .Values.traefikInternal.ports.traefik.expose.default }}
          {{- end }}

        {{- if .Values.traefikInternal.additionalArguments }}
        additionalArguments:
          {{- range .Values.traefikInternal.additionalArguments }}
          - {{ . }}
          {{- end }}
        {{- else }}
        additionalArguments: []
        {{- end }}

        env:
          {{- toYaml .Values.traefikInternal.env | nindent 10 }}

        certificatesResolvers: {}

        persistence:
          enabled: {{ .Values.traefikInternal.persistence.enabled }}
          {{- if .Values.traefikInternal.persistence.enabled }}
          storageClass: {{ .Values.traefikInternal.persistence.storageClass }}
          size: {{ .Values.traefikInternal.persistence.size }}
          {{- end }}

        ingressRoute:
          dashboard:
            enabled: {{ .Values.traefikInternal.ingressRoute.dashboard.enabled }}
            {{- if .Values.traefikInternal.ingressRoute.dashboard.enabled }}
            matchRule: {{ .Values.traefikInternal.ingressRoute.dashboard.matchRule }}
            entryPoints:
              {{- toYaml .Values.traefikInternal.ingressRoute.dashboard.entryPoints | nindent 14 }}
            {{- if .Values.traefikInternal.ingressRoute.dashboard.tls }}
            tls:
              secretName: {{ .Values.traefikInternal.ingressRoute.dashboard.tls.secretName }}
            {{- end }}
            {{- end }}

        resources:
          {{- toYaml .Values.traefikInternal.resources | nindent 10 }}

        {{- if .Values.traefikInternal.autoscaling.enabled }}
        autoscaling:
          enabled: true
          minReplicas: {{ .Values.traefikInternal.autoscaling.minReplicas }}
          maxReplicas: {{ .Values.traefikInternal.autoscaling.maxReplicas }}
          metrics:
            {{- toYaml .Values.traefikInternal.autoscaling.metrics | nindent 12 }}
        {{- end }}

  destination:
    server: https://kubernetes.default.svc
    namespace: {{ .Values.traefikInternal.namespace }}

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
      - ApplyOutOfSyncOnly=true
      - RespectIgnoreDifferences=true

  ignoreDifferences:
    - group: admissionregistration.k8s.io
      kind: ValidatingWebhookConfiguration
      jqPathExpressions:
        - .webhooks[].clientConfig.caBundle
---
# Config Application: deploys CRD-dependent resources (dashboard)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik-internal-config
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "8"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ .Values.global.repoUrl }}
    targetRevision: {{ .Values.global.targetRevision }}
    path: charts/traefik-internal-config
    helm:
      valueFiles:
        - values.yaml
        - values-{{ .Values.global.environment }}.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: traefik
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
      - SkipDryRunOnMissingResource=true
{{- end }}
```

**Step 2: Commit**

```bash
git add charts/addons/templates/traefik-internal.yaml
git commit -m "feat(charts): add traefik-internal.yaml addons template"
```

---

## Task 6: Update Addons values.yaml — Split traefik into traefikExternal and traefikInternal

Replace the `traefik:` key in `charts/addons/values.yaml` with `traefikExternal:` and add `traefikInternal:`.

**Files:**
- Modify: `charts/addons/values.yaml` (lines 780-876)

**Step 1: Replace `traefik:` block with `traefikExternal:` block**

Replace the entire `traefik:` section (lines 780-876) with `traefikExternal:` — identical content but with the key renamed. Keep all sub-keys the same.

Change line 780: `traefik:` → `traefikExternal:`

**Step 2: Add `traefikInternal:` block after `traefikExternal:`**

Add this after the `traefikExternal:` block (before the next section):

```yaml
traefikInternal:
  enabled: true
  namespace: traefik

  chart:
    name: traefik
    repo: https://traefik.github.io/charts
    version: 39.0.0

  service:
    type: LoadBalancer
    spec:
      externalTrafficPolicy: Local

  ports:
    web:
      port: 8000
      exposedPort: 80
      expose:
        default: true
      http:
        redirections:
          entryPoint:
            to: websecure
            scheme: https
            permanent: true
    websecure:
      port: 8443
      exposedPort: 443
      expose:
        default: true
      asDefault: true
      http:
        tls:
          enabled: true
      transport:
        respondingTimeouts:
          readTimeout: 0
          writeTimeout: 0
          idleTimeout: 600s

  additionalArguments:
    - --global.checknewversion=false
    - --global.sendanonymoususage=false

  env: []

  persistence:
    enabled: false

  ingressRoute:
    dashboard:
      enabled: true
      matchRule: Host(`traefik-internal.example.com`)
      entryPoints: ["websecure"]

  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 1000m
      memory: 2Gi

  deployment:
    replicas: 2

  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 5
    metrics:
      - type: Resource
        resource:
          name: cpu
          target:
            type: Utilization
            averageUtilization: 80
```

**Step 3: Commit**

```bash
git add charts/addons/values.yaml
git commit -m "feat(charts): split traefik values into traefikExternal and traefikInternal"
```

---

## Task 7: Update Addons values-localdev.yaml

Replace the `traefik:` key with both `traefikExternal:` and `traefikInternal:` sections.

**Files:**
- Modify: `charts/addons/values-localdev.yaml` (lines 73-110)

**Step 1: Replace `traefik:` with `traefikExternal:` and add `traefikInternal:`**

Replace lines 73-110 with:

```yaml
traefikExternal:
  enabled: true

  service:
    type: NodePort

  ports:
    web:
      nodePort: 30080
    websecure:
      nodePort: 30443

  globalArguments:
    - --global.checknewversion=false
    - --global.sendanonymoususage=false

  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 200m
      memory: 256Mi

  ingressRoute:
    dashboard:
      enabled: true

traefikInternal:
  enabled: true

  service:
    type: NodePort

  ports:
    web:
      nodePort: 30081
    websecure:
      nodePort: 30444

  globalArguments:
    - --global.checknewversion=false
    - --global.sendanonymoususage=false

  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 200m
      memory: 256Mi

  ingressRoute:
    dashboard:
      enabled: true
```

Note: Internal uses different NodePorts (30081/30444) to avoid conflicts with external (30080/30443).

**Step 2: Commit**

```bash
git add charts/addons/values-localdev.yaml
git commit -m "feat(charts): split traefik localdev values into external and internal"
```

---

## Task 8: Update Configuration Templates — helm-addons.tmpl

Replace the single `traefik:` section with `traefikExternal:` (keeps OIDC, static IP, port forwarding) and add `traefikInternal:` (no OIDC, dynamic IP).

**Files:**
- Modify: `configuration/templates/helm-addons.tmpl` (lines 786-918)

**Step 1: Rename `traefik:` section to `traefikExternal:`**

Change line 791: `traefik:` → `traefikExternal:`

Keep all content identical (OIDC, static IP annotation, port forwarding, volumes, cloudflare).

**Step 2: Add `traefikInternal:` section after `traefikExternal:`**

Insert before the UniFi Port Forwarding section (line 919):

```
# ============================================================================
# Traefik Internal - Internal Ingress Controller
# Sync Wave: 6
# ============================================================================

traefikInternal:
  enabled: true
  namespace: traefik

  chart:
    name: traefik
    repo: https://traefik.github.io/charts
    version: {{ .Versions.Charts.traefik }}

  service:
    type: LoadBalancer
    spec:
      externalTrafficPolicy: Local
    # No static IP - Cilium LB IPAM assigns dynamically
    # No port forwarding - internal only

  ports:
    web:
      port: 8000
      exposedPort: 80
      expose:
        default: true
      http:
        redirections:
          entryPoint:
            to: websecure
            scheme: https
            permanent: true
    websecure:
      port: 8443
      exposedPort: 443
      expose:
        default: true
      asDefault: true
      http:
        tls:
          enabled: true
      transport:
        respondingTimeouts:
          readTimeout: 0
          writeTimeout: 0
          idleTimeout: 600s
    traefik:
      port: 9000
      expose:
        default: true

  additionalArguments:
    - --global.checknewversion=false
    - --global.sendanonymoususage=false

  env: []

  persistence:
    enabled: false

  ingressRoute:
    dashboard:
      enabled: true
      matchRule: Host(`{{ .Values.TRAEFIK_INTERNAL_HOSTNAME.Value }}`)
      entryPoints: ["websecure"]
      tls:
        secretName: traefik-internal-dashboard-tls

  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 1000m
      memory: 2Gi

  deployment:
    replicas: 2

  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 5
    metrics:
      - type: Resource
        resource:
          name: cpu
          target:
            type: Utilization
            averageUtilization: 80
```

**Step 3: Update ArgoCD and Grafana ingressClassName references**

In the same file, update these lines:
- ArgoCD ingress (line ~101): `ingressClassName: {{ .Values.INGRESS_CLASS.Value }}` → `ingressClassName: {{ .Values.INGRESS_CLASS_INTERNAL.Value }}`
- Grafana ingress (line ~726): `ingressClassName: {{ .Values.INGRESS_CLASS.Value }}` → `ingressClassName: {{ .Values.INGRESS_CLASS_INTERNAL.Value }}`
- Argo Workflows ingress (line ~999): `ingressClassName: {{ .Values.INGRESS_CLASS.Value }}` → `ingressClassName: {{ .Values.INGRESS_CLASS_INTERNAL.Value }}`

**Step 4: Remove OIDC middleware annotations from ArgoCD, Grafana, and Argo Workflows**

Remove these lines from each (since they'll be on internal Traefik which has no OIDC):
```yaml
        traefik.ingress.kubernetes.io/router.middlewares: traefik-oidc-auth@kubernetescrd
```

**Step 5: Commit**

```bash
git add configuration/templates/helm-addons.tmpl
git commit -m "feat(config): split traefik template into external and internal sections"
```

---

## Task 9: Update Configuration Templates — helm-apps.tmpl

Update all ingress class references and remove OIDC middleware annotations from internal apps.

**Files:**
- Modify: `configuration/templates/helm-apps.tmpl`

**Step 1: Update global ingressClassName**

Change the global section (line 24):
```
  ingressClassName: {{ .Values.INGRESS_CLASS.Value }}
```
→
```
  ingressClassNameExternal: {{ .Values.INGRESS_CLASS_EXTERNAL.Value }}
  ingressClassNameInternal: {{ .Values.INGRESS_CLASS_INTERNAL.Value }}
```

**Step 2: Update Plex ingressClassName to external**

Change Plex ingress (line 153):
```
    ingressClassName: {{ .Values.INGRESS_CLASS.Value }}
```
→
```
    ingressClassName: {{ .Values.INGRESS_CLASS_EXTERNAL.Value }}
```

**Step 3: Update all other apps to internal**

For each of these apps, change `{{ .Values.INGRESS_CLASS.Value }}` → `{{ .Values.INGRESS_CLASS_INTERNAL.Value }}`:
- Sonarr (line 236)
- Radarr (line 320)
- Prowlarr (line 388)
- NZBGet (line 456)
- Tautulli (line 516)
- LazyLibrarian (line 592)
- Home Assistant (line 656)
- ArgoCD (line 878)

**Step 4: Remove OIDC middleware annotations from all internal apps**

Remove these lines from Sonarr, Radarr, Prowlarr, NZBGet, Tautulli, LazyLibrarian, Home Assistant, and ArgoCD:
```yaml
        # OIDC authentication via Traefik plugin
        traefik.ingress.kubernetes.io/router.middlewares: traefik-oidc-auth@kubernetescrd
```

Also remove from ArgoCD the OIDC middleware annotation:
```yaml
          # OIDC authentication via Traefik plugin
          traefik.ingress.kubernetes.io/router.middlewares: traefik-oidc-auth@kubernetescrd
```

**Step 5: Commit**

```bash
git add configuration/templates/helm-apps.tmpl
git commit -m "feat(config): update app templates with external/internal ingress classes"
```

---

## Task 10: Update Static Values Files — Applications

Update the non-generated values files with new ingress class names.

**Files:**
- Modify: `charts/applications/values.yaml`

**Step 1: Update Plex ingressClassName**

Change Plex ingress (line ~161): `ingressClassName: traefik` → `ingressClassName: external`

**Step 2: Update all other apps to internal**

For each app in values.yaml, change `ingressClassName: traefik` → `ingressClassName: internal`:
- Sonarr (line ~247)
- Radarr (line ~335)
- Prowlarr (line ~407)
- NZBGet (line ~479)
- Tautulli (line ~543)
- LazyLibrarian (line ~623)
- Home Assistant (line ~697)

**Step 3: Update global ingressClassName**

If there's a global `ingressClassName: traefik` in the global section, split it into:
```yaml
  ingressClassNameExternal: external
  ingressClassNameInternal: internal
```

**Step 4: Commit**

```bash
git add charts/applications/values.yaml
git commit -m "feat(charts): update application ingress classes to external/internal"
```

---

## Task 11: Regenerate values-homelab.generated.yaml

Run the config export to regenerate the generated values files with all the template changes.

**Files:**
- Auto-generated: `charts/addons/values-homelab.generated.yaml`
- Auto-generated: `charts/applications/values-homelab.generated.yaml`

**Step 1: Validate configuration**

Run: `task config:validate`
Expected: PASS

**Step 2: Export configuration**

Run: `task config:export`
Expected: Generated files updated

**Step 3: Verify generated files contain correct ingress classes**

Check that `charts/addons/values-homelab.generated.yaml` contains:
- `traefikExternal:` section (with OIDC, static IP, port forwarding)
- `traefikInternal:` section (no OIDC, no static IP)
- ArgoCD ingress: `ingressClassName: internal`
- Grafana ingress: `ingressClassName: internal`

Check that `charts/applications/values-homelab.generated.yaml` contains:
- Plex: `ingressClassName: external`
- All other apps: `ingressClassName: internal`
- No OIDC middleware annotations on any app

**Step 4: Commit**

```bash
git add charts/addons/values-homelab.generated.yaml charts/applications/values-homelab.generated.yaml
git commit -m "chore: regenerate homelab values with dual traefik config"
```

---

## Task 12: Lint and Template Validation

Validate all Helm charts render correctly.

**Files:** None (validation only)

**Step 1: Lint all charts**

Run: `task chart:lint`
Expected: All charts pass linting

**Step 2: Template addons chart**

Run: `task chart:template:addons`
Expected: Renders without errors; produces both `traefik-external` and `traefik-internal` Application resources

**Step 3: Template applications chart**

Run: `task chart:template:applications` (if available)
Expected: Renders without errors; ingress classes are correct

**Step 4: Fix any issues discovered**

If linting or templating fails, fix the issues and re-run.

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(charts): resolve lint/template issues from dual traefik split"
```

---

## Task 13: Update CLAUDE.md Embedded Chart Versions

Update the CLAUDE.md file to reflect the new values key names for Traefik.

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update Traefik embedme references**

The CLAUDE.md has embedded chart version snippets. Update the Traefik section to reference `traefikExternal` instead of the old `traefik` key path in values.yaml.

**Step 2: Run embedme**

Run: `task docs:embedme`

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md traefik references for dual ingress"
```

---

## Task 14: Update Project Memory

Record the architectural decision and update Serena memories.

**Files:**
- Modify: `docs/project_notes/decisions.md`

**Step 1: Add ADR entry**

Add to `docs/project_notes/decisions.md`:

```markdown
- **2026-02-13 — Dual Traefik Ingress Controllers**: Split single Traefik into external (`external` IngressClass, static IP 172.16.100.200, OIDC, port forwarding) and internal (`internal` IngressClass, dynamic IP, no OIDC). Plex uses external; all other apps use internal. OIDC middleware annotations removed from internal apps. Design doc: `docs/plans/2026-02-13-dual-traefik-ingress-design.md`.
```

**Step 2: Commit**

```bash
git add docs/project_notes/decisions.md
git commit -m "docs: record dual traefik ADR in project decisions"
```
