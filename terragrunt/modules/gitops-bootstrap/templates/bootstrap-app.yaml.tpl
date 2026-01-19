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
