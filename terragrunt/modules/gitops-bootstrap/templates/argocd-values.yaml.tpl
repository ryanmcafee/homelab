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
    # Enable App of Apps health status progression
    # This allows parent applications to track child application health
    resource.customizations.health.argoproj.io_Application: |
      hs = {}
      hs.status = "Progressing"
      hs.message = ""
      if obj.status ~= nil then
        if obj.status.health ~= nil then
          hs.status = obj.status.health.status
          if obj.status.health.message ~= nil then
            hs.message = obj.status.health.message
          end
        end
      end
      return hs

server:
  ingress:
    enabled: ${server_ingress_enabled}
    ingressClassName: traefik
    hostname: ${server_host}
    tls: true
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt
      external-dns.alpha.kubernetes.io/hostname: ${server_host}

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
