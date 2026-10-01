#!/bin/sh
# ADR-043 level-2 probes, one phase per argument, against $NATS_URL with seeds in $SEEDS.
# Every refusal is matched on the server's own violation text: natscli exits 0 on a refused
# request and on a timed-out one, so an exit code alone proves nothing.
set -u
: "${NATS_URL:?}" "${SEEDS:?}"
TENANT=${TENANT:-local}
WORK_SUBJECT="pf.$TENANT.workload.deployment.promote.v1.wq"
WORK_CONSUMER=workload-operator-deployment-promote-v1
EVENT_SUBJECT="pf.$TENANT.workload.deployment.deployed.v1.ev"
RQ_SUBJECT="pf.$TENANT.workload.deployment.describe.v1.rq"
CREATE_FILTERED="\$JS.API.CONSUMER.CREATE.PF_WORK.$WORK_CONSUMER.$WORK_SUBJECT"
failures=0
scratch=$(mktemp -d)

# natscli 0.4.0 prints an asynchronous -ERR on req and reply only under --trace.
trace_flag() {
  case $1 in
  req | reply) echo --trace ;;
  esac
}

as() {
  principal=$1
  shift
  nats --server "$NATS_URL" --nkey "$SEEDS/$principal.nk" --inbox-prefix "_INBOX.$principal" --timeout 3s \
    $(trace_flag "$1") "$@" 2>&1
}

# Backgrounded through exec, so `$!` is the nats process and `kill "$!"` stops it.
as_bg() {
  principal=$1
  shift
  exec nats --server "$NATS_URL" --nkey "$SEEDS/$principal.nk" --inbox-prefix "_INBOX.$principal" \
    $(trace_flag "$1") "$@" 2>&1
}

pass() { printf 'PASS %s: %s\n' "$1" "$2"; }
fail() {
  printf 'FAIL %s: %s\n%s\n' "$1" "$2" "$3" | sed '3,$s/^/    /'
  failures=$((failures + 1))
}

# expect ID DESC PATTERN -- output must contain PATTERN (fixed string).
expect() {
  id=$1 desc=$2 pattern=$3 output=$4
  case $output in
  *"$pattern"*) pass "$id" "$desc" ;;
  *) fail "$id" "$desc (expected: $pattern)" "$output" ;;
  esac
}

# succeeded ID DESC PATTERN OUTPUT -- the success text is present and no violation is.
succeeded() {
  id=$1 desc=$2 pattern=$3 output=$4
  case $output in
  *Violation*) fail "$id" "$desc" "$output" ;;
  *"$pattern"*) pass "$id" "$desc" ;;
  *) fail "$id" "$desc (expected: $pattern)" "$output" ;;
  esac
}

refused_pub() { expect "$1" "$2" "Permissions Violation for Publish to \"$3\"" "$4"; }
refused_sub() { expect "$1" "$2" "Permissions Violation for Subscription to \"$3\"" "$4"; }

# rtt prints "<url>: <duration>" only after a completed round trip; otherwise "failed".
measured_rtt() { printf '%s\n' "$1" | grep -Eq ': [0-9.]+(ns|µs|us|ms|s)$'; }

# A pod Ready before its Service routes makes a refusal probe read "no servers available".
# await_server ID PRINCIPAL
await_server() {
  principal=$2
  for _ in $(seq 30); do
    out=$(as "$principal" rtt)
    measured_rtt "$out" && return 0
    sleep 2
  done
  fail "$1" "$NATS_URL accepts a connection from $principal within 60s" "$out"
  return 1
}

phase_cold() {
  id=cold_start_no_maintainer_account
  await_server $id nack || return
  expect $id "an anonymous client is refused at connect" "Authorization Violation" \
    "$(nats --server "$NATS_URL" --timeout 3s pub "$EVENT_SUBJECT" anonymous 2>&1)"
  nats auth nkey gen user --output "$scratch/stranger.nk" >/dev/null
  expect $id "a well-formed nkey the server was not given is refused" "Authorization Violation" \
    "$(nats --server "$NATS_URL" --nkey "$scratch/stranger.nk" --timeout 3s pub "$EVENT_SUBJECT" stranger 2>&1)"
  for principal in $PRINCIPALS; do
    out=$(as "$principal" rtt)
    if measured_rtt "$out"; then
      pass $id "$principal connects on its synthetic key"
    else
      fail $id "$principal connects on its synthetic key" "$out"
    fi
  done
}

stream_add() {
  as nack stream add "$1" --subjects "$2" --retention "$3" --storage file --replicas 1 \
    --discard "$4" --max-age "$5" --max-bytes 64MB --dupe-window 2m --defaults
}

consumer_add() {
  principal=$1 stream=$2 name=$3 filter=$4
  as "$principal" consumer add "$stream" "$name" --pull --filter "$filter" --ack explicit \
    --max-deliver 5 --wait 30s --max-pending 256 --deliver all --replay instant --defaults
}

phase_streams() {
  id=start_bind_pull_ack_reconnect
  stream_created PF_EVENTS 'pf.*.*.*.*.*.ev' limits old 168h
  stream_created PF_WORK 'pf.*.*.*.*.*.wq' work new 24h
  stream_created PF_DLQ 'pf.*.*.*.*.*.dl' limits old 720h
  nack_consumer_created PF_EVENTS verify-workload-v1 'pf.*.workload.*.*.v1.ev'
  nack_consumer_created PF_DLQ dlq-reporter-observability-v1 'pf.*.*.*.*.*.dl'
  nack_consumer_created PF_WORK "$WORK_CONSUMER" 'pf.*.workload.deployment.promote.v1.wq'
}

stream_created() {
  succeeded $id "nack creates $1" "Stream $1 was created" "$(stream_add "$@")"
}

nack_consumer_created() {
  succeeded $id "nack creates $2" "Information for Consumer $1 > $2" "$(consumer_add nack "$1" "$2" "$3")"
  expect $id "$2 exists on $1 afterwards" "\"name\": \"$2\"" "$(as nack consumer info "$1" "$2" --json)"
}

phase_start() {
  id=start_bind_pull_ack_reconnect
  for n in 1 2 3 4; do
    out=$(as workload-operator pub --jetstream "$EVENT_SUBJECT" "event-$n")
    expect $id "workload-operator publishes event-$n and PF_EVENTS acknowledges it" "Stored in Stream: PF_EVENTS" "$out"
  done
  expect $id "verify binds to its durable" "verify-workload-v1" \
    "$(as verify consumer info PF_EVENTS verify-workload-v1)"
  expect $id "verify pulls and ACKs" "event-1" "$(as verify consumer next PF_EVENTS verify-workload-v1 --ack)"
  expect $id "verify pulls and NAKs" "event-2" "$(as verify consumer next PF_EVENTS verify-workload-v1 --nak)"
  expect $id "the NAKed message is redelivered and ACKed" "event-2" \
    "$(as verify consumer next PF_EVENTS verify-workload-v1 --ack)"
  expect $id "verify pulls and TERMs" "event-3" "$(as verify consumer next PF_EVENTS verify-workload-v1 --term)"

  expect $id "workload-operator binds the durable nack created" "$WORK_CONSUMER" \
    "$(as workload-operator consumer info PF_WORK "$WORK_CONSUMER")"
  out=$(as platform-api pub --jetstream "$WORK_SUBJECT" work-1)
  expect $id "platform-api enqueues work and PF_WORK acknowledges it" "Stored in Stream: PF_WORK" "$out"
  expect $id "workload-operator pulls and ACKs the work item" "work-1" \
    "$(as workload-operator consumer next PF_WORK "$WORK_CONSUMER" --ack)"
}

phase_reconnect() {
  id=start_bind_pull_ack_reconnect
  await_server $id verify || return
  expect $id "after a server restart verify reads event-4, the one left unacknowledged" "event-4" \
    "$(as verify consumer next PF_EVENTS verify-workload-v1 --ack)"
  out=$(as workload-operator pub --jetstream "$EVENT_SUBJECT" event-5)
  expect $id "workload-operator publishes after the restart" "Stored in Stream: PF_EVENTS" "$out"
  expect $id "verify reads the post-restart event" "event-5" \
    "$(as verify consumer next PF_EVENTS verify-workload-v1 --ack)"
}

phase_lifecycle() {
  id=lifecycle_refused
  for verb in 'STREAM.DELETE.PF_DLQ' 'STREAM.PURGE.PF_DLQ' 'STREAM.MSG.DELETE.PF_DLQ' \
    'STREAM.MSG.GET.PF_DLQ' 'STREAM.SNAPSHOT.PF_DLQ' 'STREAM.RESTORE.PF_DLQ' \
    'CONSUMER.DELETE.PF_EVENTS.verify-workload-v1' 'ACCOUNT.PURGE'; do
    refused_pub $id "nack is refused \$JS.API.$verb" "\$JS.API.$verb" "$(as nack req "\$JS.API.$verb" '{}')"
  done
  for principal in verify dlq-reporter workload-operator platform-api gitops-bridge; do
    refused_pub $id "$principal is refused STREAM.CREATE" '$JS.API.STREAM.CREATE.PF_ROGUE' \
      "$(as "$principal" req '$JS.API.STREAM.CREATE.PF_ROGUE' '{"name":"PF_ROGUE","subjects":["rogue.>"]}')"
    refused_pub $id "$principal is refused CONSUMER.DELETE" '$JS.API.CONSUMER.DELETE.PF_EVENTS.verify-workload-v1' \
      "$(as "$principal" req '$JS.API.CONSUMER.DELETE.PF_EVENTS.verify-workload-v1' '')"
  done
  refused_pub $id "verify is refused STREAM.INFO on a stream it does not read" '$JS.API.STREAM.INFO.PF_WORK' \
    "$(as verify req '$JS.API.STREAM.INFO.PF_WORK' '')"
  expect $id "every stream survives the refused verbs" "PF_DLQ" "$(as nack stream ls --names)"
}

phase_cross_principal() {
  id=cross_principal_inbox_and_ack_refused
  refused_sub $id "dlq-reporter cannot subscribe to verify's inbox" '_INBOX.verify.>' \
    "$(as dlq-reporter sub '_INBOX.verify.>' --count 1)"
  refused_sub $id "verify cannot subscribe to every inbox" '_INBOX.>' "$(as verify sub '_INBOX.>' --count 1)"
  for ack in "\$JS.ACK.PF_EVENTS.verify-workload-v1.1.1.1.0.0" \
    "\$JS.ACK.hub.ACCHASH.PF_EVENTS.verify-workload-v1.1.1.1.0.0.token"; do
    refused_pub $id "dlq-reporter cannot ACK verify's message ($ack)" "$ack" "$(as dlq-reporter pub "$ack" '+ACK')"
    refused_pub $id "workload-operator cannot ACK verify's message ($ack)" "$ack" "$(as workload-operator pub "$ack" '+ACK')"
  done
  succeeded $id "verify may publish its own ACK subject (control)" \
    'Published 4 bytes to "$JS.ACK.PF_EVENTS.verify-workload-v1.1.1.1.0.0"' \
    "$(as verify pub '$JS.ACK.PF_EVENTS.verify-workload-v1.1.1.1.0.0' '+ACK')"
  refused_pub $id "platform-api cannot publish another producer's event" "pf.$TENANT.gitops.application.synced.v1.ev" \
    "$(as platform-api pub "pf.$TENANT.gitops.application.synced.v1.ev" forged)"
}

create_as() { as workload-operator req "$1" "$2"; }
create_body() { printf '{"stream_name":"%s","config":{%s"ack_policy":"explicit"}}' "${2:-PF_WORK}" "$1"; }

# ADR-043 D6b: no workload principal holds any consumer-create grant, so every entrance is refused.
phase_consumer_create() {
  id=consumer_create_name_only_reach
  filter="\"filter_subject\":\"$WORK_SUBJECT\","
  refused_pub $id "nameless create with a body Durable is refused" '$JS.API.CONSUMER.CREATE.PF_WORK' \
    "$(create_as '$JS.API.CONSUMER.CREATE.PF_WORK' "$(create_body '"durable_name":"rogue-durable",')")"
  refused_pub $id "nameless create with a body Name and no Durable is refused" '$JS.API.CONSUMER.CREATE.PF_WORK' \
    "$(create_as '$JS.API.CONSUMER.CREATE.PF_WORK' "$(create_body '"name":"rogue-named",')")"
  refused_pub $id "legacy DURABLE.CREATE is refused" '$JS.API.CONSUMER.DURABLE.CREATE.PF_WORK.rogue' \
    "$(create_as '$JS.API.CONSUMER.DURABLE.CREATE.PF_WORK.rogue' "$(create_body '"durable_name":"rogue",')")"
  refused_pub $id "the fully-filtered form is refused for a new name" "\$JS.API.CONSUMER.CREATE.PF_WORK.rogue.$WORK_SUBJECT" \
    "$(create_as "\$JS.API.CONSUMER.CREATE.PF_WORK.rogue.$WORK_SUBJECT" "$(create_body "\"durable_name\":\"rogue\",$filter")")"
  refused_pub $id "the fully-filtered form is refused as an update of its own durable" "$CREATE_FILTERED" \
    "$(create_as "$CREATE_FILTERED" "$(create_body "\"durable_name\":\"$WORK_CONSUMER\",$filter\"max_deliver\":1,")")"
  consumers=$(as nack consumer ls PF_WORK --names | grep -v '^$' | sort | tr '\n' ' ')
  expect $id "PF_WORK holds no consumer but the declared one" "$WORK_CONSUMER " "$consumers"
  case $consumers in
  *rogue*) fail $id "no rogue consumer exists on PF_WORK" "$consumers" ;;
  *) pass $id "no rogue consumer exists on PF_WORK" ;;
  esac
}

# ADR-043 D6b. Measured on v2.15.0 before it: a create body's deliver_subject is not checked
# against the creator's publish grant, so a self-creating principal could push its stream to any
# subscribed subject. The fix is that the create is refused and the bind is the only path.
phase_push_redirect() {
  id=consumer_create_name_only_reach
  (as_bg rq-responder-bare sub "$RQ_SUBJECT" --count 1 >"$scratch/redirect.out") &
  listener=$!
  sleep 1
  refused_pub $id "workload-operator cannot publish to $RQ_SUBJECT itself (control)" "$RQ_SUBJECT" \
    "$(as workload-operator pub "$RQ_SUBJECT" direct)"
  refused_pub $id "workload-operator is refused a push create delivering to $RQ_SUBJECT" "$CREATE_FILTERED" \
    "$(create_as "$CREATE_FILTERED" "$(create_body "\"durable_name\":\"$WORK_CONSUMER\",\"filter_subject\":\"$WORK_SUBJECT\",\"deliver_subject\":\"$RQ_SUBJECT\",")")"
  out=$(as workload-operator consumer info PF_WORK "$WORK_CONSUMER" --json)
  expect $id "workload-operator binds the NACK-created durable" "\"durable_name\": \"$WORK_CONSUMER\"" "$out"
  case $out in
  *deliver_subject*) fail $id "the bound durable is still pull after the refused push create" "$out" ;;
  *) pass $id "the bound durable is still pull after the refused push create" ;;
  esac
  as platform-api pub --jetstream "$WORK_SUBJECT" redirect-attempt >/dev/null
  expect $id "workload-operator pulls the work item through its bound durable" "redirect-attempt" \
    "$(as workload-operator consumer next PF_WORK "$WORK_CONSUMER" --ack)"
  sleep 1
  kill "$listener" 2>/dev/null
  case $(cat "$scratch/redirect.out") in
  *redirect-attempt*) fail $id "no work item reached $RQ_SUBJECT" "$(cat "$scratch/redirect.out")" ;;
  *) pass $id "no work item reached $RQ_SUBJECT" ;;
  esac
}

phase_rq() {
  id=rq_reply_needs_no_inbox_grant
  # Each responder outlives its reply: the refusal reaches it as an asynchronous -ERR.
  (as_bg rq-responder-bare reply "$RQ_SUBJECT" bare-reply >"$scratch/bare.out") &
  responder=$!
  sleep 1
  out=$(as platform-api req "$RQ_SUBJECT" ping)
  sleep 1
  kill "$responder" 2>/dev/null
  case $out in
  *bare-reply*) fail $id "a responder with no allow_responses is refused the reply" "$out" ;;
  *) expect $id "a responder with no allow_responses is refused the reply" \
    "Permissions Violation for Publish to \"_INBOX.platform-api." "$(cat "$scratch/bare.out")" ;;
  esac

  (as_bg rq-responder-bounded reply "$RQ_SUBJECT" bounded-reply ) >/dev/null &
  responder=$!
  sleep 1
  expect $id "allow_responses {max: 1, expires: 5s} delivers the reply to _INBOX.platform-api" "bounded-reply" \
    "$(as platform-api req "$RQ_SUBJECT" ping)"
  kill "$responder" 2>/dev/null
  refused_pub $id "the bounded responder cannot publish to the requester's inbox unsolicited" "_INBOX.platform-api.unsolicited" \
    "$(as rq-responder-bounded pub _INBOX.platform-api.unsolicited x)"
  refused_sub $id "the bounded responder cannot read the requester's inbox" "_INBOX.platform-api.>" \
    "$(as rq-responder-bounded sub '_INBOX.platform-api.>' --count 1)"

  (as_bg rq-responder-bounded reply "$RQ_SUBJECT" --command "sleep 7" >"$scratch/late.out") &
  responder=$!
  sleep 1
  nats --server "$NATS_URL" --nkey "$SEEDS/platform-api.nk" --inbox-prefix _INBOX.platform-api \
    --timeout 10s req "$RQ_SUBJECT" ping >/dev/null 2>&1
  sleep 1
  kill "$responder" 2>/dev/null
  expect $id "a reply after the 5s expires bound is refused" \
    "Permissions Violation for Publish to \"_INBOX.platform-api." "$(cat "$scratch/late.out")"
}

measured() { printf 'MEASURED %s: %s\n' "$1" "$2"; }

MOVE_STREAM=${MOVE_STREAM:-NACK_MOVE_PROBE}

# where_is ACCOUNT -- present, absent or unreadable, from the account's stream name list.
# tenant and move are accounts on the keyed server; shared is the cluster bus the rendered
# NACK's global -s points at.
where_is() {
  case $1 in
  tenant) out=$(as nack stream ls --names) rc=$? ;;
  move) out=$(nats --server "$NATS_URL" --nkey "$SEEDS/nack-move.nk" --inbox-prefix _INBOX.nack \
    --timeout 3s stream ls --names 2>&1) rc=$? ;;
  shared) out=$(nats --server "${SHARED_URL:?}" --timeout 3s stream ls --names 2>&1) rc=$? ;;
  esac
  case $rc:$out in
  0:*error* | 0:*Violation* | [!0]*) echo unreadable ;;
  *) printf '%s\n' "$out" | grep -qx "$MOVE_STREAM" && echo present || echo absent ;;
  esac
}

# placement -- "tenant=<state> move=<state> shared=<state>".
placement() {
  line=""
  for account in tenant move shared; do
    line="${line:+$line }$account=$(where_is $account)"
  done
  echo "$line"
}

# readable DESC PLACEMENT -- a reading with an unreadable account is a FAIL, not an answer.
readable() {
  case $2 in
  *unreadable*) fail nack_account_on_stream_move "every account is readable $1" "$2" ;;
  esac
}

phase_move_placed() {
  id=nack_account_on_stream_move
  for _ in $(seq 30); do
    [ "$(where_is tenant)" = present ] && break
    sleep 2
  done
  succeeded $id "the control-loop NACK creates $MOVE_STREAM in its Stream's account" \
    "\"name\": \"$MOVE_STREAM\"" "$(as nack stream info "$MOVE_STREAM" --json)"
  now=$(placement)
  readable "before the move" "$now"
  measured $id "before the move: $now"
}

# The same controller on nack's own declared key; its inbox is _INBOX.<nuid>, outside _INBOX.nack.>.
phase_declared_placed() {
  id=nack_account_on_stream_move
  for _ in $(seq 15); do
    [ "$(where_is tenant)" = present ] && break
    sleep 2
  done
  now=$(placement)
  readable "with nack's declared key" "$now"
  measured $id "$MOVE_STREAM on nack's declared key, within 30s: $now"
}

# Records every placement seen in the 60s after spec.account moved, so the timeline is the answer.
phase_move_moved() {
  id=nack_account_on_stream_move
  last=""
  for second in $(seq 0 2 60); do
    now=$(placement)
    readable "${second}s after the move" "$now"
    [ "$now" != "$last" ] && measured $id "${second}s after spec.account moved to NACK_MOVE: $now"
    last=$now
    sleep 2
  done
}

for phase in "$@"; do
  "phase_$phase"
done
rm -rf "$scratch"
printf '%s failure(s)\n' "$failures"
[ "$failures" -eq 0 ]
