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
      # The base domain never lives in git: Terraform injects it here and the
      # gitops chart derives the bootstrap (ArgoCD) hostname from global.domain.
      parameters:
        - name: global.domain
          value: ${base_fqdn}
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
