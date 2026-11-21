# OpenClaw Control UI: tailnet-only access

The OpenClaw Control UI holds a Claude subscription token and whichever provider API keys are
enabled, behind one shared bearer token. It is therefore not on any Envoy Gateway
(`docs/apps/openclaw.md` Exposure). Remote access is a tailnet-only Ingress whose proxy is a tailnet
device with no LAN listener, scoped by a tailnet ACL grant to one tag.

Off by default. A fork gets a healthy cluster without any of this.

## What renders when it is on

| Piece | Where | What it does |
|-------|-------|--------------|
| `spec.networking.ingress` on the `OpenClawInstance` | `charts/openclaw/templates/instance.yaml` | `className: tailscale`, `tailscale.com/hostname` and `tailscale.com/tags` from the config keys |
| Tailscale proxy device | created by the operator from that Ingress | Joins the tailnet as `<hostname>`, carries `OPENCLAW_TAILNET_TAG`, terminates HTTPS with a tailnet certificate |
| `allowedIngressNamespaces: [tailscale]` | same template | The instance NetworkPolicy denies by default; the proxy's namespace has to be named or its backend is unreachable |

The proxy's own Service is `ClusterIP`, and `openclaw-lan-reachable` keeps the instance Service
`ClusterIP` too, so nothing in this path has a LAN address.

## Enable steps, in order

The ACL grant must be live **before** the Ingress first reconciles. Tailscale does not apply a grant
retroactively to a session, and an untagged or ungranted proxy registers and then answers nothing,
which reads as a broken deploy rather than a missing grant.

1. **Choose the tag** and make the operator's OAuth client an owner of it. In `policy.sops.hujson`:

   ```hujson
   "tagOwners": {
     "tag:k8s-openclaw": ["tag:k8s-operator"],
   },
   ```

   Without this the operator cannot register a device with the tag and the Ingress stays pending.

2. **Add the grant**, replacing the source with the users, groups or device tags that may reach the
   Control UI. Keep it as narrow as the need — this is the whole of the authorization above the
   bearer token:

   ```hujson
   {"src": ["autogroup:admin"], "dst": ["tag:k8s-openclaw"], "ip": ["tcp:443"]},
   ```

   Do **not** reuse `tag:k8s`. That is the subnet router's tag (`proxyConfig.defaultTags`), so a
   grant naming it reaches the router as well, and no grant can then separate the two.
   `openclaw-untagged-tailnet` rejects that at level 0.

3. **Apply the policy** the way it is normally applied: commit the re-encrypted
   `policy.sops.hujson` and merge to `main`. `.github/workflows/tailscale-acl.yml` tests it on the PR
   and applies it on merge, behind the `production` environment approval. Editing the file needs the
   ACL age key (`.sops.yaml`), which agents do not hold.

4. **Set the three config keys** for the environment and merge:

   ```yaml
   OPENCLAW_TAILNET_EXPOSURE: "true"
   OPENCLAW_TAILNET_HOSTNAME: openclaw.<tailnet>.ts.net
   OPENCLAW_TAILNET_TAG: tag:k8s-openclaw
   ```

   The tailnet name is PII: set it in the environment file, never in
   `configuration/environments/homelab.yaml.example`.

5. **Let ArgoCD reconcile** the `openclaw` Application. The chart fails to render if the hostname or
   tag is missing, so a half-configured endpoint fails at level 0 rather than in the cluster.

## Verify

```bash
kubectl --context homelab-readonly -n openclaw get ingress
kubectl --context homelab-readonly -n tailscale get pods         # the proxy StatefulSet
tailscale status | rg openclaw                                   # the device and its tags
curl -sS -o /dev/null -w '%{http_code}\n' https://openclaw.<tailnet>.ts.net/healthz
```

The Control UI itself needs the gateway bearer token; `/healthz` is the unauthenticated liveness
path the PostSync smoke hook already uses.

Negative check — from a LAN host that is **not** on the tailnet, both must fail:

```bash
curl -sS --max-time 5 https://openclaw.<tailnet>.ts.net/healthz   # no route to the tailnet address
curl -sS --max-time 5 http://<any-lan-address>:18789/healthz      # Service is ClusterIP
```

## Rollback

| Undo | How | Effect |
|------|-----|--------|
| Revoke access, keep the endpoint | Remove the grant from `policy.sops.hujson`, merge | The device stays registered and answers nobody |
| Remove the endpoint | `OPENCLAW_TAILNET_EXPOSURE: "false"`, merge | ArgoCD prunes the Ingress; the operator deletes the proxy device. Back to in-cluster only |
| Emergency | `tailscale device delete` the proxy, or disable the device in the admin console | Immediate; ArgoCD recreates it on the next sync, so pair it with one of the above |

Nothing here touches the subnet router, the API server proxy or split DNS.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Ingress has no address, proxy pod absent | Operator cannot register the tag | Step 1: `tagOwners` for the tag must list `tag:k8s-operator` |
| Device registers, connection times out | No grant, or the grant names the wrong tag | Step 2; `tailscale status` shows the device's actual tags |
| TLS error on the MagicDNS name | HTTPS certificates off for the tailnet | Enable HTTPS in the admin console (the same prerequisite as the API server proxy) |
| `503` from the proxy | NetworkPolicy is not admitting the proxy namespace | `allowedIngressNamespaces` should contain `tailscale`; check the rendered Instance |
| `401` with a token | Gateway token rotated | `docs/apps/openclaw.md` Gateway token rotation |

## Why not a second Envoy Gateway

A dedicated Gateway would take a second address from the load-balancer pool and answer any LAN
client that dialed it; the tailnet would be a naming convention rather than a boundary. The tailnet
proxy has no LAN listener, so there is no LAN path to forget to close. `openclaw-shared-route`
enforces the choice: it rejects an `OpenClawInstance` ingress on any class but `tailscale`.
