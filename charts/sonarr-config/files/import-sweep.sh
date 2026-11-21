#!/bin/sh
# Import sweep: asks Sonarr/Radarr to import every release left in IMPORT_PATH.
#
# The app treats a scan path as one release, so each entry of IMPORT_PATH gets its own
# POST /api/v3/command {name: COMMAND_NAME, path: <entry>, importMode: Move}
# (DownloadedEpisodesScan for Sonarr, DownloadedMoviesScan for Radarr), polled through
# GET /api/v3/command/<id> until it ends. Move puts each accepted file into the library
# and removes the release from the downloads folder; a rejected release stays and is
# logged (the reason is in the app's log and its manual import screen).
# Exits 1 when a command fails, the run passes TIMEOUT_SECONDS or the API is unreachable.
set -eu

: "${ARR_URL:?ARR_URL is required}"
: "${COMMAND_NAME:?COMMAND_NAME is required}"
: "${IMPORT_PATH:?IMPORT_PATH is required}"
CONFIG_XML="${CONFIG_XML:-/app-config/config.xml}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-3000}"
POLL_SECONDS="${POLL_SECONDS:-2}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() {
  log "ERROR: $*"
  exit 1
}

if [ -z "${ARR_API_KEY:-}" ]; then
  [ -r "$CONFIG_XML" ] || fail "no ARR_API_KEY and $CONFIG_XML is not readable"
  ARR_API_KEY="$(sed -n 's:.*<ApiKey>\([^<]*\)</ApiKey>.*:\1:p' "$CONFIG_XML" | head -n1)"
  [ -n "$ARR_API_KEY" ] || fail "no <ApiKey> in $CONFIG_XML"
fi

api() {
  method="$1" path="$2"
  shift 2
  curl -fsS --retry 3 --retry-delay 5 --max-time 60 -X "$method" \
    -H "X-Api-Key: ${ARR_API_KEY}" -H 'Content-Type: application/json' \
    "$@" "${ARR_URL%/}/api/v3/${path}"
}

# Top-level scalar of a command resource; the nested body never carries id, status, result or message.
field() {
  printf '%s' "$1" | tr -d '\n' | grep -o "\"$2\": *\(\"[^\"]*\"\|[0-9][0-9]*\)" | tail -n1 |
    sed 's/^"[^"]*": *//; s/^"//; s/"$//'
}

json_string() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

entries() { find "$IMPORT_PATH" -mindepth 1 -maxdepth 1 ! -name '.*'; }

[ -d "$IMPORT_PATH" ] || fail "$IMPORT_PATH is not mounted in this pod"
before="$(entries | wc -l | tr -d ' ')"
log "$before entries in $IMPORT_PATH; running $COMMAND_NAME (importMode Move) on each"

deadline=$(($(date +%s) + TIMEOUT_SECONDS))
imported=0
rejected=0
failed=0
listing="$(entries)"
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  [ "$(date +%s)" -lt "$deadline" ] || fail "run passed ${TIMEOUT_SECONDS}s; the next run continues"
  payload="$(printf '{"name":"%s","path":"%s","importMode":"Move"}' "$COMMAND_NAME" "$(json_string "$entry")")"
  response="$(api POST command --data "$payload")" || fail "POST command $COMMAND_NAME for $entry failed"
  command_id="$(field "$response" id)"
  [ -n "$command_id" ] || fail "no command id in the response for $entry: $response"
  status="queued"
  while [ "$status" = queued ] || [ "$status" = started ]; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "command $command_id for $entry still $status after ${TIMEOUT_SECONDS}s"
    sleep "$POLL_SECONDS"
    response="$(api GET "command/$command_id")" || fail "GET command/$command_id failed"
    status="$(field "$response" status)"
  done
  result="$(field "$response" result)"
  if [ "$status" != completed ]; then
    failed=$((failed + 1))
    log "FAILED $command_id status=$status: ${entry##*/}: $(field "$response" message)"
  elif [ -e "$entry" ]; then
    rejected=$((rejected + 1))
    log "left   $command_id result=$result: ${entry##*/}: $(field "$response" message)"
  else
    imported=$((imported + 1))
    log "moved  $command_id result=$result: ${entry##*/}"
  fi
done <<EOF
$listing
EOF

after="$(entries | wc -l | tr -d ' ')"
log "done: $imported moved, $rejected left (rejected or nothing to import), $failed failed; $after entries left in $IMPORT_PATH (was $before)"
[ "$failed" -eq 0 ] || fail "$failed $COMMAND_NAME commands failed"
