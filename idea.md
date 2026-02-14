Add support for deploying another traefik ingress controller that also gets a load balancer ip.
Also will need to add support for deploying another ingress controller class: `internal` that references the internal traefik ingress controller.

The plex application should use the external ingress controller.
All other applications that deploy ingress resources should use the internal ingress controller.

There are existing argocd applications:

    traefik
    traefik-config
    traefik-dependencies

These should be updated to:

    traefik-external
    traefik-external-config
    traefik-external-dependencies

There should be 3 new argocd applications:
    traefik-internal
    traefik-internal-config
    traefik-internal-dependencies
