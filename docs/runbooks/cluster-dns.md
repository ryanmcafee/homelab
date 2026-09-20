# Cluster DNS: how pods resolve names, and what breaks when the upstream does

Every name a pod looks up, internal or external, ends up at one upstream resolver: the gateway.
There is no second one. When it stops answering, cluster DNS fails, and until 2026-09-20 nothing
alerted on it.

## The path

```
pod → CoreDNS (kube-system, 2 replicas)
    → forward . /etc/resolv.conf          # the Corefile ships with Talos
    → 127.0.0.53                          # Talos host DNS on each node
    → GATEWAY_IP                          # machine.network.nameservers, one entry
```

CoreDNS caches for 30 s, so a brief upstream blip is invisible. A longer one is not: with no
healthy upstream CoreDNS answers `SERVFAIL`, and callers see `server misbehaving`.

`*.<domain>` resolves through the gateway too (split-horizon: the gateway answers with the
internal address, public DNS answers with the public one). That is why the upstream list cannot
simply gain a public resolver — see [Why there is only one upstream](#why-there-is-only-one-upstream).

CoreDNS is **not** in this repo. Talos renders the Corefile as a bootstrap manifest, so the cache
and forward settings cannot be changed through GitOps as things stand.

## Alerts

Both are `critical` and defined in `charts/addons/templates/kube-prometheus-stack.yaml`
(`additionalPrometheusRulesMap.homelab-infrastructure`).

| Alert | Fires when | Means |
|---|---|---|
| `HomelabClusterDNSUpstreamDown` | `coredns_forward_healthcheck_broken_total` increases for 10m | CoreDNS has marked every upstream unhealthy. The cause. |
| `HomelabClusterDNSFailing` | SERVFAIL > 10 % of answers for 15m, at more than 1 answer/s | Name resolution is failing cluster-wide. The symptom. |

`TargetDown` does not cover this: CoreDNS stays up and keeps answering, it just answers SERVFAIL.
The 10 % threshold sits between a normal week (3 % peak) and the 2026-09-03 outage (25 % sustained);
the rate guard stops an idle cluster from alerting on a handful of queries.

## When one of them fires

1. **Confirm from inside the cluster.** A name that must resolve, and one that must not be cached:
   ```bash
   kubectl -n kube-system run dnscheck --rm -it --restart=Never --image=busybox:1.36 -- \
     nslookup github.com
   ```
2. **Ask the upstream directly.** If this fails, the cluster is fine and the gateway is not:
   ```bash
   dig +short github.com @GATEWAY_IP
   ```
3. **Check CoreDNS itself** only after the two above, because it is rarely the cause:
   ```bash
   kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
   kubectl -n kube-system get pods -l k8s-app=kube-dns
   ```
   Both replicas failing identically points upstream. One replica failing points at that pod.
4. **Fix the gateway.** In practice this has meant the UniFi gateway's DNS service, not the
   cluster. The UniFi controller's own name resolution and WAN status are the place to look.

Pods that crash-loop through the outage (external-dns, Renovate) recover on their own. Jobs that
failed during it do not: they expire through `ttlSecondsAfterFinished` instead
([alerting.md](./alerting.md)).

## Why there is only one upstream

`machine.network.nameservers` in
`terragrunt/environments/homelab/talos-cluster/terragrunt.hcl` is the list, and it holds the
gateway alone. Adding a public resolver such as `1.1.1.1` looks like the obvious fix and is not:

- Talos host DNS spreads queries across the upstreams it has rather than strictly preferring the
  first. A public resolver would therefore answer some `*.<domain>` queries **while the gateway is
  healthy**, returning the public address instead of the internal one.
- Hosts that exist only internally would intermittently come back `NXDOMAIN`.

A second upstream is only safe if it also serves the internal zone. The options, none of them free:

| Option | Cost |
|---|---|
| A second internal resolver that serves the same zone | New infrastructure to run and keep in sync |
| Take the Corefile over from Talos and use `forward . GATEWAY_IP 1.1.1.1 { policy sequential }` | Owning a bootstrap component Talos currently manages; public answers still leak for internal names once the gateway is unhealthy |
| Leave one upstream, alert on it | Today's choice: an outage pages in 15m instead of being found 17 days later |

## History

- **2026-09-03, 05:40–15:30 UTC.** The gateway stopped answering. CoreDNS logged 62,059
  broken-upstream events and returned 66,051 SERVFAILs, a quarter of all answers, for 8.5 hours.
  Both replicas were affected equally. external-dns crash-looped, the Renovate CronJob failed seven
  times and gave up, and three DuckDNS updates failed. No alert fired. Found on 2026-09-20 while
  triaging something else, by which time the only evidence left was a Prometheus series and one
  container's previous-log. The alerts above were added in response.
