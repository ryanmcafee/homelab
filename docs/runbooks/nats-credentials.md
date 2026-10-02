# Runbook: NATS principal credentials

Generation, custody, activation, rotation and revocation of the ADR-043 bus principal nkeys.

The declaration `contracts/events/bus-principals.v1.yaml` says what each principal may do. This
runbook covers the other half: the key material that lets it do it. Identity is
operator-supplied, permissions are contract -- which is what lets a fork generate its own key
pairs and get the same enforcement.

**What is a secret and what is not.** An nkey pair is a public key (`U...`, 56 characters) and a
private seed (`SU...`, 58 characters). The server holds only public keys, so
`NATS_PRINCIPAL_NKEYS` and `NATS_SYSTEM_ACCOUNT_NKEY` are ordinary configuration and may be
committed, logged and rendered. A seed never may. `charts/addons` refuses a value starting `S` in
either field.

## 1. Generate

```bash
bun scripts/nats-principals-keygen.ts --dir ~/.homelab/nats-seeds
```

One user key pair per non-pending principal in the declaration, plus a separate `$SYS` user. The
seeds are written to the directory you name -- 0700, files 0600, exclusive creation, symlinks
refused, never overwritten -- and the PUBLIC map is printed:

```text
# seeds: /home/op/.homelab/nats-seeds (mode 700)
# 11 generated, 0 reused
NATS_PRINCIPAL_NKEYS="nack=U...,workload-operator=U...,..."
NATS_SYSTEM_ACCOUNT_NKEY="U..."
```

Rules the script enforces, so you do not have to remember them:

- `--dir` is required and absolute, and may not be inside the repository.
- A rerun **reuses** every seed already present and mints only what is missing. It never replaces
  one: regenerating a key silently breaks every client still holding the old seed.
- `--check` validates an existing directory and prints the same map without writing anything.
- `--rotate <principal>` is the deliberate replacement, and it refuses to run until you have
  moved the old seed aside yourself.
- Nothing prints a seed. Not stdout, not stderr, not an error message, not a command line.

`$SYS` takes a **user** key, not an account key: `charts/addons` renders
`nats.systemAccountNkey` into `accounts.$SYS.users[].nkey`, which is a user position. The
variable name does not settle that; the renderer does.

## 2. Custody

### Workload principals (homelab)

Put each seed in a 1Password item named `nats-principal-<principal>`, in one vault, with the seed
in a field **labelled exactly `nats.nk`**. Then set the vault path:

```yaml
# configuration/environments/homelab.yaml
NATS_CREDENTIALS_1P_PATH: "vaults/<your vault>/items"
```

`charts/addons/templates/nats.yaml` renders one `OnePasswordItem` per principal at
sync wave 9 -- before the server at wave 10 -- producing the Secret `nats-principal-<principal>`
with key `nats.nk` in the `nats` namespace. A principal whose client runs elsewhere is
replicated explicitly, per principal:

```yaml
nats:
  credentials:
    extraNamespaces:
      argo-events-bridge: [argo-events]
```

There is no blanket copy, and a namespace named for a principal the server does not accept is
refused at render.

### The `$SYS` break-glass key

**The `$SYS` seed does not go in the cluster and does not go in the workload vault.** No platform
component holds the system account -- NACK included, which the `nack` chart's `nats-sys-creds`
default invites -- so a `$SYS` Secret in the bus namespace would be a break-glass credential
mounted next to every ordinary client. The chart renders no item for it.

Instead:

1. A **dedicated restricted 1Password item**, separate from the workload vault, with access
   limited to the operators who are allowed to administer the bus. Ordinary agents get no
   standing access.
2. An **encrypted offline copy** the operator controls, reachable without the cluster, without
   External Secrets and without 1Password Connect -- because the case you need `$SYS` for is the
   one where the identity path is down. An age- or GPG-encrypted file on removable media is
   enough; the requirement is that recovering it depends on nothing in the cluster.

Record, next to the item and never in Git: the custodians, a reference to where the offline copy
lives, and the date of the last successful recovery drill. Never record the seed.

A localdev `$SYS` key must never be reused in homelab. Kind mints none at all (see section 4).

## 3. Activate

Activation is the single change that flips the bus from anonymous to authenticated, and it cannot
half-land: with `NATS_PRINCIPAL_NKEYS` set there is no `no_auth_user`, so a client with no key
reaches no account.

**Prerequisites, all of them, before you set it:**

- [ ] **Every** declared non-pending principal appears in the map, not only the ones with a
      workload today. The chart enforces exact coverage in both directions, because the server
      refuses every principal absent from the accounts block and does not fall back to anonymous
      for it -- a partial map is an outage with no error until a client connects.
- [ ] The map reached the chart intact. Set it through `configuration/environments/<set>.yaml`,
      which renders YAML. `helm --set nats.principalNkeys=a=U1,b=U2` splits on the unescaped
      comma and keeps only the first pair; the coverage guard turns that into a render error
      rather than a one-user account.
- [ ] Every seed is delivered and readable in the namespace its client runs in.
- [ ] NACK connects as the `nack` principal through its `Account` resource (`spec.nkey`, never
      `spec.creds` -- the static backend issues raw nkeys and `creds` is an nsc file).
- [ ] `NATS_BOX_PRINCIPALS` names the principals nats-box needs a context for. Empty means
      nats-box is not deployed, which is the honest state rather than a pod that cannot connect.
- [ ] Every `nats` call site holds a named context. The `tests/e2e/nats` chainsaw suite still
      execs `nats` with no context at roughly twenty call sites; that conversion is tracked
      separately, and activating before it lands turns a green suite red.
- [ ] `argo-events-bridge` is still `pending` in the declaration, so `charts/addons` refuses a
      key for it. Do not add one until the bridge exists.

Then:

```bash
# Validate presence and correspondence WITHOUT printing a seed: compare the public key derived
# from the delivered Secret against the one the server was configured with.
kubectl -n nats get secret nats-principal-nack \
  -o jsonpath='{.data.nats\.nk}' | base64 -d > "$seedfile"   # a 0600 file you delete after
bun -e 'import {fromSeed} from "nkeys.js";
  console.log(fromSeed(new TextEncoder().encode(
    (await Bun.file(process.argv[2]).text()).trim())).getPublicKey())' "$seedfile"
```

The printed public key must equal this principal's value in `NATS_PRINCIPAL_NKEYS`. A mismatch
means the vault item and the configuration disagree -- fix that before activating, not after.

Then set the key and let ArgoCD reconcile:

```bash
# configuration/environments/homelab.yaml
NATS_PRINCIPAL_NKEYS: "nack=U...,verify=U...,..."
NATS_SYSTEM_ACCOUNT_NKEY: "U..."
```

**ESO synchronisation is not proof.** A synced Secret says the bytes are in the cluster; it says
nothing about whether a running process re-read them. Confirm the client actually connected --
NACK reconciling a `Stream`, a nats-box context resolving -- before calling it done.

**Rollback path:** clear `NATS_PRINCIPAL_NKEYS`. The accounts block stops rendering and the bus
returns to its previous anonymous state. That is a real rollback while nothing has been rotated;
it is **not** available as a response to a compromised key (section 6).

## 4. Kind (localdev)

Kind has no vault, and a committed Kind seed is still a committed secret. The bootstrap mints the
key material instead:

```bash
bun scripts/localdev-kind.ts nats-seeds     # also run as part of `up`
```

- Refuses any context Kind did not create. `kubectl get` against the wrong context exits 0 with
  empty results, so this guard is the difference between throwaway credentials and a Secret
  written into homelab.
- Creates the `nats` namespace, then one Secret `nats-principal-<principal>` per principal with
  the seed under `nats.nk`. The seed travels on stdin, never in argv.
- **Reuses** any seed already in the cluster. A routine `task localdev:kind` changes no
  credential.
- Writes the PUBLIC map to `.nats/localdev-principal-nkeys.env` (git-ignored, 0600). The private
  halves exist only as Secrets in the cluster and in no file.
- Mints no `$SYS` key. Nothing on Kind holds the system account, so break-glass on Kind is
  recreating the cluster.
- Compares what it derived against the map it wrote last time and **names any principal whose key
  moved**. A Secret deleted by hand is reminted, so an already-activated configuration would still
  carry the old public key and the server would refuse that client with nothing to show why.
  Re-render the addons values from the map when that warning appears.

Delivering the seeds does **not** activate authentication. The bus stays anonymous until
`NATS_PRINCIPAL_NKEYS` is set from that file and the values are re-rendered, with the section 3
prerequisites met.

## 5. Rotate

**This renderer accepts one key per principal.** The values map holds one key per name, so a
second pair replaces the first rather than adding an accepted key -- `charts/addons` now refuses
a duplicate name outright, so the failure is a render error rather than a silently dropped key.
There is therefore **no acceptance overlap**, and rotation is a bounded maintenance interruption.
Do not invent overlap support, and do not enable anonymous access to cover the gap.

1. Announce the interruption for the principal being rotated. Only its clients are affected;
   other principals keep connecting.
2. Move the old seed aside and mint a replacement:
   ```bash
   mv ~/.homelab/nats-seeds/nack.nk ~/.homelab/nats-seeds/nack.nk.rotated-$(date +%F)
   bun scripts/nats-principals-keygen.ts --dir ~/.homelab/nats-seeds --rotate nack
   ```
3. Update the 1Password item's `nats.nk` field to the new seed.
4. Update this principal's public key in `NATS_PRINCIPAL_NKEYS` and let the render land. The
   server now accepts the new key and refuses the old one.
5. Restart or demonstrably reload every consumer of that principal. A pod holding the old seed in
   memory does not pick up a Secret update.
6. Prove the new key connects and the old key is refused **on a fresh connection**.
7. Keep the retired seed file until step 6 passes, then destroy it.

**Unmeasured, and not claimed here:** whether an already-established session is cut or allowed to
continue when its key is removed. That is the declaration's level-2
`rotation_and_revocation_drill`, and it needs a running server. Plan the interruption as though
established sessions survive until they reconnect, and measure it in that drill.

If ESO is slow or a restart fails mid-rotation, the correct state is the interruption continuing
with the new public key in place. Reverting the public key to restore availability puts a
retired credential back in service; reverting to no key at all makes the bus anonymous. Neither
is a rotation step.

## 6. Revoke a compromised key

Revocation takes precedence over availability, and it needs approval on the ticket plus the
owning engineer -- it is a live credential mutation.

1. Remove the compromised public key from `NATS_PRINCIPAL_NKEYS` and land the render. The server
   stops accepting it. **Do not clear the whole map**: that makes the bus anonymous, which is
   strictly worse than one refused principal.
2. Disconnect sessions established under that key through a verified supported mechanism.
   `$SYS` administration is the path; the exact verb and its effect are part of the level-2
   drill, so confirm the sessions are actually gone rather than assuming removal cut them.
3. Mint a replacement seed, update the vault item, restart the consumers.
4. Prove both: the new key succeeds, and the compromised key is refused on a fresh connection.
5. **Never roll back to the compromised key.** An External Secrets update is delivery, not
   revocation -- putting the old seed back in the vault would restore it.

If the compromised credential is `$SYS`, use the offline copy to administer the bus while you
replace it, and treat every account as needing review: a system-account credential has
cross-account reach over every tenant's streams.

## Residual risk

- Anyone who can read a Secret in a namespace, and any compromised process running there, can
  extract that principal's seed. The account and subject permissions bound what the seed can do;
  they do not stop it being read.
- Offline `$SYS` custody and vault availability are operational dependencies, not properties of
  this repository.
- Subject authorization is ADR-043's enforcement and is tested separately. This runbook covers
  the credential, not the grant.

## Related

- `contracts/events/bus-principals.v1.yaml` -- the declaration and its conformance split
- `docs/event-backbone.md` -- the declaration to `nats.conf` path and the measured refusals
- `docs/contracts/byo-extension-points.md` -- the operator-supplied seam
- ADR-043 -- accounts, per-tenant users and the closed `$JS.API`
