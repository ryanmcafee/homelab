---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${app_name}
  namespace: ${namespace}
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: ${repo_url}
    targetRevision: ${target_revision}
    path: ${path}
    helm:
      valueFiles:
        - values.yaml
        - values-${environment}.yaml
      # Neither the base domain nor the fork's own repository lives in git:
      # Terraform injects both here. The gitops chart derives the bootstrap
      # (ArgoCD) hostname from global.domain, and hands global.repoUrl to every
      # child Application so a fork reconciles itself, not the upstream repo.
      parameters:
        - name: global.domain
          value: ${base_fqdn}
        - name: global.repoUrl
          value: ${repo_url}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${namespace}
  syncPolicy:
%{ if auto_sync ~}
    automated:
      prune: ${auto_prune}
      selfHeal: ${self_heal}
%{ endif ~}
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
