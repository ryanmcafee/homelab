#!/bin/sh
# Renders the NATS server exactly as the localdev `nats` Application would with $PAIRS as
# nats.principalNkeys, plus the two labelled request/reply probe users, into $OUT/server.yaml.
# `render.sh box-image` prints the nats-box image that same chart version pins.
set -eu
root=$(git rev-parse --show-toplevel)
app='select(.kind == "Application" and .metadata.name == "nats") | .spec.source'

if [ "${1:-}" = box-image ]; then
  addons=$(helm template addons "$root/charts/addons" \
    -f "$root/charts/addons/values.yaml" -f "$root/charts/addons/values-localdev.yaml" \
    --show-only templates/nats.yaml)
  repo=$(printf '%s\n' "$addons" | yq "$app | .repoURL")
  version=$(printf '%s\n' "$addons" | yq "$app | .targetRevision")
  helm show values nats --repo "$repo" --version "$version" |
    yq '.natsBox.container.image | .repository + ":" + .tag'
  exit 0
fi

: "${PAIRS:?PAIRS must carry the <principal>=<public key> pairs from keygen.sh}"
: "${PROBE_PAIRS:?PROBE_PAIRS must carry the rq-responder-* public keys}"
: "${NAMESPACE:?NAMESPACE must name the namespace the server is rendered into}"
: "${OUT:?OUT must name the output directory}"
mkdir -p "$OUT"

PAIRS="$PAIRS" yq -n '.nats.principalNkeys = strenv(PAIRS)' >"$OUT/keys.yaml"
helm template addons "$root/charts/addons" \
  -f "$root/charts/addons/values.yaml" \
  -f "$root/charts/addons/values-localdev.yaml" \
  -f "$OUT/keys.yaml" \
  --show-only templates/nats.yaml >"$OUT/addons.yaml"
repo=$(yq "$app | .repoURL" "$OUT/addons.yaml")
chart=$(yq "$app | .chart" "$OUT/addons.yaml")
version=$(yq "$app | .targetRevision" "$OUT/addons.yaml")
yq "$app | .helm.values" "$OUT/addons.yaml" >"$OUT/values.yaml"

tenant=$(yq '.nats.tenant' "$root/charts/addons/values-localdev.yaml")
account=$(yq '.config.merge.accounts | keys | .[] | select(. != "$SYS")' "$OUT/values.yaml")
[ "$(printf '%s\n' "$account" | wc -l)" -eq 1 ] || { echo "expected one tenant account, got: $account" >&2; exit 1; }
[ "$(yq '.config.merge.accounts["$SYS"].users | length' "$OUT/values.yaml")" -eq 0 ] ||
  { echo "the render gives \$SYS a user; cold start must hold no maintainer account" >&2; exit 1; }
declared=$(printf '%s' "$PAIRS" | tr ',' '\n' | grep -c .)
rendered=$(yq ".config.merge.accounts.$account.users | length" "$OUT/values.yaml")
[ "$declared" -eq "$rendered" ] || { echo "$declared keys supplied, $rendered users rendered" >&2; exit 1; }

# Probe users are NOT declared principals: they measure the server's response permission,
# which the declaration has no responder to carry yet (rq_reply_needs_no_inbox_grant).
rq="pf.$tenant.workload.deployment.describe.v1.rq"
for pair in $(printf '%s' "$PROBE_PAIRS" | tr ',' ' '); do
  name=${pair%%=*}
  NKEY=${pair#*=} NAME=$name RQ=$rq yq -i "
    .config.merge.accounts.$account.users += [{
      \"nkey\": strenv(NKEY),
      \"permissions\": {
        \"publish\": {\"allow\": [\"\$JS.API.INFO\"]},
        \"subscribe\": {\"allow\": [strenv(RQ), \"_INBOX.\" + strenv(NAME) + \".>\"]}
      }
    }]" "$OUT/values.yaml"
  case $name in
  rq-responder-bounded)
    NKEY=${pair#*=} yq -i "(.config.merge.accounts.$account.users[] | select(.nkey == strenv(NKEY)) | .permissions.allow_responses) = {\"max\": 1, \"expires\": \"5s\"}" "$OUT/values.yaml"
    ;;
  esac
done

# nack-probe (in the tenant account) and nack-move (alone in NACK_MOVE) are labelled probe users
# holding nack's grants plus `_INBOX.>`: NACK 0.24.0 has no inbox-prefix option, so it cannot
# use nack's declared `_INBOX.nack` (nack_account_on_stream_move).
if [ -n "${MOVE_PAIRS:-}" ]; then
  nack_key=$(printf '%s' "$PAIRS" | tr ',' '\n' | sed -n 's/^nack=//p')
  probe_key=$(printf '%s' "$MOVE_PAIRS" | tr ',' '\n' | sed -n 's/^nack-probe=//p')
  move_key=$(printf '%s' "$MOVE_PAIRS" | tr ',' '\n' | sed -n 's/^nack-move=//p')
  [ -n "$nack_key" ] || { echo "PAIRS carries no nack key to copy" >&2; exit 1; }
  [ -n "$probe_key" ] && [ -n "$move_key" ] || { echo "MOVE_PAIRS must carry nack-probe and nack-move" >&2; exit 1; }
  nack_user=$(NACK=$nack_key yq -o=json -I=0 ".config.merge.accounts.$account.users[] | select(.nkey == strenv(NACK))" "$OUT/values.yaml")
  widened() { printf '%s' "$nack_user" | KEY=$1 yq -p=json -o=json -I=0 '.nkey = strenv(KEY) | .permissions.subscribe.allow += ["_INBOX.>"]'; }
  PROBE=$(widened "$probe_key") MOVE=$(widened "$move_key") yq -i "
    .config.merge.accounts.$account.users += [strenv(PROBE) | from_json] |
    .config.merge.accounts.NACK_MOVE = .config.merge.accounts.$account |
    .config.merge.accounts.NACK_MOVE.users = [strenv(MOVE) | from_json]" \
    "$OUT/values.yaml"
  [ "$(yq '.config.merge.accounts.NACK_MOVE.users | length' "$OUT/values.yaml")" -eq 1 ] ||
    { echo "NACK_MOVE did not render exactly one user" >&2; exit 1; }
  NACK=$nack_key yq -e ".config.merge.accounts.$account.users[] | select(.nkey == strenv(NACK)) |
    .permissions.subscribe.allow | all_c(. != \"_INBOX.>\")" "$OUT/values.yaml" >/dev/null ||
    { echo "nack lost its key or gained _INBOX.> in $account" >&2; exit 1; }
fi

helm template nats "$chart" --repo "$repo" --version "$version" \
  --namespace "$NAMESPACE" -f "$OUT/values.yaml" |
  yq 'select(.kind != null and .kind != "PodMonitor")' >"$OUT/server.yaml"
yq 'select(.kind == "ConfigMap") | .data."nats.conf"' "$OUT/server.yaml" >"$OUT/nats.conf"
printf 'rendered %s %s from %s for account %s (%s declared users + probes)\n' \
  "$chart" "$version" "$repo" "$account" "$declared"
