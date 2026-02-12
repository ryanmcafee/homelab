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
    # Enable ksops plugin for SOPS decryption
    kustomize.buildOptions: "--enable-alpha-plugins --enable-exec"
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
      traefik.ingress.kubernetes.io/service.serversscheme: http
      traefik.ingress.kubernetes.io/router.middlewares: traefik-oidc-auth@kubernetescrd

dex:
  enabled: ${dex_enabled}

notifications:
  enabled: ${notifications_enabled}

controller:
  metrics:
    enabled: true
  resources:
    limits:
      cpu: 2000m
      memory: 4Gi
    requests:
      cpu: 1000m
      memory: 2Gi

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

  # SOPS/ksops configuration for decrypting secrets
  env:
    - name: XDG_CONFIG_HOME
      value: /.config
    - name: SOPS_AGE_KEY_FILE
      value: /.config/sops/age/keys.txt

  # Mount age key and custom tools
  volumes:
    - name: custom-tools
      emptyDir: {}
    - name: sops-age
      secret:
        secretName: sops-age-key
    - name: cmp-tmp
      emptyDir: {}
    - name: homelab-config
      secret:
        secretName: homelab-environment-config
        optional: true

  volumeMounts:
    - name: custom-tools
      mountPath: /usr/local/bin/ksops
      subPath: ksops
    - name: custom-tools
      mountPath: /usr/local/bin/kustomize
      subPath: kustomize
    - name: sops-age
      mountPath: /.config/sops/age

  # Init container to install ksops
  initContainers:
    - name: install-ksops
      image: viaductoss/ksops:v4.3.2
      command: ["/bin/sh", "-c"]
      args:
        - echo "Installing KSOPS...";
          cp /usr/local/bin/ksops /custom-tools/ksops;
          cp /usr/local/bin/kustomize /custom-tools/kustomize;
          echo "Done.";
      volumeMounts:
        - name: custom-tools
          mountPath: /custom-tools

  # CMP sidecar for homelab config plugin
  extraContainers:
    - name: homelab-cmp
      image: ghcr.io/ryanmcafee/homelab-cmp:latest
      command: [/var/run/argocd/argocd-cmp-server]
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
      env:
        - name: ARGOCD_EXEC_TIMEOUT
          value: "90"
      volumeMounts:
        - mountPath: /var/run/argocd
          name: var-files
        - mountPath: /home/argocd/cmp-server/plugins
          name: plugins
        - mountPath: /tmp
          name: cmp-tmp
        - mountPath: /config/homelab.yaml
          name: homelab-config
          subPath: homelab.yaml
          readOnly: true

applicationSet:
  enabled: true
