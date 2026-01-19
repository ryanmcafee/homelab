## ArgoCD Helm Values Template
## This template is used by the gitops-bootstrap module

global:
  domain: ${server_host}

configs:
  params:
    server.insecure: true
  cm:
    admin.enabled: ${admin_enabled}
    timeout.reconciliation: 60s
    application.instanceLabelKey: argocd.argoproj.io/instance

server:
  ingress:
    enabled: ${server_ingress_enabled}
    hosts:
      - ${server_host}
    tls:
      - secretName: argocd-server-tls
        hosts:
          - ${server_host}

dex:
  enabled: ${dex_enabled}

notifications:
  enabled: ${notifications_enabled}

controller:
  metrics:
    enabled: true
  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 250m
      memory: 256Mi

repoServer:
  metrics:
    enabled: true
  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 250m
      memory: 256Mi

applicationSet:
  enabled: true
