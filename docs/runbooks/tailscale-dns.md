# Tailscale split DNS for the homelab domain

Private hostnames (`argocd.<domain>`, `plex.<domain>`, ...) only exist on the UniFi gateway's
resolver. A phone or laptop on the tailnet but off the LAN asks its own DNS and gets nothing, or
the public record. Split DNS fixes that: the tailnet tells every device to send lookups for
`<domain>` to one nameserver, and that nameserver is the gateway.

## How it fits together

| Piece | Where | What it does |
|-------|-------|--------------|
| Subnet router | `Connector homelab-subnet-router` (charts/addons, `TAILSCALE_ADVERTISE_ROUTES`) | Routes the LAN /24 onto the tailnet, which is why the gateway is reached at its address in that /24 (`GATEWAY_IP`) and not on another VLAN |
| ACL grant | `policy.sops.hujson` → `autogroup:member -> <GATEWAY_IP>/32 udp:53,tcp:53` | Opens only DNS, only to the gateway host; applied by `tailscale-acl.yml` on merge |
| Split DNS | tailnet DNS settings (`task tailscale:dns:apply`) | `<DOMAIN> -> GATEWAY_IP`; every other lookup keeps using the device's own resolver |
| Script | `scripts/tailscale-dns.ts` | `status`, `apply` (idempotent PATCH of that one domain), `remove`; defaults `DOMAIN` and `GATEWAY_IP` from `configuration/environments/homelab.yaml` |

The DNS settings are not part of the ACL policy file, so they go through the Tailscale API
with an OAuth client scoped to `dns`. "Override local DNS" is not needed and stays off.

## Human steps (one time, in order)

1. **Merge the ACL grant.** `tailscale-acl.yml` tests the policy on the PR and applies it on
   merge behind the `production` environment approval. Without the grant, devices can reach the
   gateway's other ports but not DNS.
2. **Create the OAuth client.** Tailscale admin console → Settings → OAuth clients → Generate:
   scope **DNS** with read and write, no tags. Store it in 1Password under the item the script
   reads (`op://homelab/tailscale-dns-oauth`):

   ```bash
   op item create --vault homelab --category "API Credential" --title tailscale-dns-oauth \
     "client_id[text]=<client id>" "client_secret[password]=<client secret>"
   ```

   The operator's OAuth client (`tailscale-operator-oauth`) does not have the `dns` scope and
   returns HTTP 403; do not widen it.
3. **Apply.**

   ```bash
   task tailscale:dns:apply -- --dry-run   # prints the PATCH body, calls nothing
   task tailscale:dns:apply                # idempotent
   task tailscale:dns:status
   ```

4. **Check from a device off the LAN** with "Use Tailscale DNS" on (the default on phones):

   ```bash
   tailscale dns query argocd.<domain>
   ```

   It should return the private address the gateway hands out on the LAN. If the phone still
   gets the old answer, toggle Tailscale off and on so it picks up the new DNS configuration.

## Notes

- The gateway must be addressed inside the advertised /24. The same UniFi gateway answers on its
  other VLAN addresses on the LAN, but those are not routed onto the tailnet.
- Devices on the LAN are unaffected: the Mac keeps `accept-routes` off and uses the DHCP resolver
  directly (see `docs/project_notes/key_facts.md`).
- `task tailscale:dns:remove` clears just this domain; other split-DNS domains are never
  touched because the script uses PATCH, not PUT.
