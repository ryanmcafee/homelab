#!/usr/bin/env bash
# Radarr corrupted-movie scan (charts/radarr-config, templates/corruption-scan-cronjob.yaml).
#
# For every movie Radarr reports as having a file:
#   1. ffprobe the file: it must open and carry a video stream (a file with no
#      container duration must also decode its first SAMPLE_SECONDS).
#   2. DEEP_CHECK=true: decode the video keyframes for SAMPLE_SECONDS at a few points
#      (SAMPLE_POINTS, percent of the duration); a truncated file fails near the end,
#      a damaged bitstream fails where it is damaged. Keyframes only keeps it cheap.
# A file that fails is unplayable. For each one, through the Radarr API:
#   a. BLOCKLIST_RELEASE=true: mark the release that was grabbed for it as failed, so
#      the next search does not grab the same broken release again,
#   b. delete the movie file (DELETE /api/v3/moviefile/{id}),
#   c. run the automatic search for the movie (command MoviesSearch).
#
# Guards, because a storage problem looks exactly like a corrupt library:
#   - a file changed within MIN_AGE_MINUTES is skipped (it may still be importing),
#   - a missing file is skipped (Radarr's own disk scan handles that),
#   - a probe that times out is inconclusive and skipped,
#   - more than MAX_DELETIONS corrupt files in one run aborts the run with no
#     deletions and exits 1 (KubeJobFailed), since that is far likelier a mount or
#     NAS fault than real corruption,
#   - DRY_RUN=true reports what it would do and changes nothing.
set -euo pipefail

: "${RADARR_URL:?RADARR_URL is required}"
DRY_RUN="${DRY_RUN:-false}"
DEEP_CHECK="${DEEP_CHECK:-true}"
BLOCKLIST_RELEASE="${BLOCKLIST_RELEASE:-true}"
MAX_DELETIONS="${MAX_DELETIONS:-5}"
MIN_AGE_MINUTES="${MIN_AGE_MINUTES:-360}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-120}"
SAMPLE_SECONDS="${SAMPLE_SECONDS:-10}"
SAMPLE_POINTS="${SAMPLE_POINTS:-5 50 95}"
CONFIG_XML="${CONFIG_XML:-/radarr-config/config.xml}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if [ -z "${RADARR_API_KEY:-}" ]; then
  if [ ! -r "$CONFIG_XML" ]; then
    log "ERROR: no RADARR_API_KEY and $CONFIG_XML is not readable"
    exit 1
  fi
  RADARR_API_KEY="$(sed -n 's:.*<ApiKey>\([^<]*\)</ApiKey>.*:\1:p' "$CONFIG_XML" | head -n1)"
  if [ -z "$RADARR_API_KEY" ]; then
    log "ERROR: no <ApiKey> in $CONFIG_XML"
    exit 1
  fi
fi

api() {
  local method="$1" path="$2"
  shift 2
  curl -fsS --retry 3 --retry-delay 5 --max-time 120 -X "$method" \
    -H "X-Api-Key: ${RADARR_API_KEY}" -H 'Content-Type: application/json' \
    "$@" "${RADARR_URL%/}/api/v3/${path}"
}

# Prints the reason a file is unplayable; prints nothing for a good file.
# Exit 0 = decided (good or corrupt), 2 = inconclusive (timeout).
check_file() {
  local file="$1" probe rc duration offset point points start last

  rc=0
  probe="$(timeout "$PROBE_TIMEOUT" ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_type:format=duration,start_time -of json "$file" </dev/null 2>&1)" || rc=$?
  if [ "$rc" -eq 124 ]; then
    return 2
  fi
  if [ "$rc" -ne 0 ]; then
    printf 'ffprobe failed: %s' "$(printf '%s' "$probe" | tr '\n' ' ' | cut -c1-300)"
    return 0
  fi
  if ! printf '%s' "$probe" | jq -e '(.streams // []) | any(.codec_type == "video")' >/dev/null 2>&1; then
    printf 'no video stream'
    return 0
  fi
  duration="$(printf '%s' "$probe" | jq -r '.format.duration // "0"' 2>/dev/null || echo 0)"
  offset="$(printf '%s' "$probe" | jq -r '.format.start_time // "0"' 2>/dev/null || echo 0)"
  awk -v o="$offset" 'BEGIN { exit !(o ~ /^-?[0-9.]+$/) }' || offset=0
  points="$SAMPLE_POINTS"
  if ! awk -v d="$duration" 'BEGIN { exit !(d + 0 > 0) }'; then
    # No container duration: nothing to seek against, so check the start of the
    # file, even without DEEP_CHECK. A file that cannot decode its opening is unplayable.
    duration=0
    points=0
  elif [ "$DEEP_CHECK" != "true" ]; then
    return 0
  fi

  for point in $points; do
    # Sample start in the file's own timeline (start_time + percent of duration),
    # clamped so the window ends at the end of the file.
    start="$(awk -v d="$duration" -v o="$offset" -v p="$point" -v s="$SAMPLE_SECONDS" \
      'BEGIN { t = d * p / 100; if (t + s > d) t = d - s; if (t < 0) t = 0; printf "%.3f", o + t }')"

    # 1. The data is there: demux the window and require a video packet at or past
    #    its start. A truncated file keeps its full duration in the header, and a
    #    seek past the end still returns the packets before the seek point.
    rc=0
    timeout "$PROBE_TIMEOUT" ffprobe -v error -select_streams v:0 \
      -read_intervals "${start}%+${SAMPLE_SECONDS}" -show_entries packet=pts_time,dts_time \
      -of csv=p=0 "$file" </dev/null >"$WORK_DIR/packets" 2>"$WORK_DIR/errors" || rc=$?
    if [ "$rc" -eq 124 ]; then
      return 2
    fi
    last="$(awk -F, '{ for (i = 1; i <= NF; i++) if ($i ~ /^-?[0-9.]+$/ && (!n++ || $i + 0 > m)) m = $i + 0 }
      END { if (n) printf "%.3f", m; else print "none" }' "$WORK_DIR/packets")"
    if [ "$rc" -ne 0 ] || [ "$last" = "none" ] \
      || ! awk -v l="$last" -v s="$start" 'BEGIN { exit !(l + 0.5 >= s) }'; then
      printf 'no video data at %ss (%s%%; last packet %s): %s' "$start" "$point" "$last" \
        "$(tr '\n' ' ' <"$WORK_DIR/errors" | cut -c1-300)"
      return 0
    fi

    # 2. The data decodes: decode the keyframes in the window. -xerror turns the
    #    first decode error into a non-zero exit. Keyframes only keeps it cheap.
    rc=0
    timeout "$PROBE_TIMEOUT" ffmpeg -nostdin -hide_banner -v error -xerror \
      -skip_frame nokey -ss "$(awk -v s="$start" -v o="$offset" 'BEGIN { printf "%.3f", s - o }')" \
      -i "$file" -t "$SAMPLE_SECONDS" -map 0:v:0 -f null - </dev/null 2>"$WORK_DIR/errors" || rc=$?
    if [ "$rc" -eq 124 ]; then
      return 2
    fi
    if [ "$rc" -ne 0 ]; then
      printf 'decode failed at %ss (%s%%): %s' "$start" "$point" \
        "$(tr '\n' ' ' <"$WORK_DIR/errors" | cut -c1-300)"
      return 0
    fi
  done
  return 0
}

log "checking Radarr at ${RADARR_URL} (dry run: ${DRY_RUN}, deep check: ${DEEP_CHECK})"
api GET system/status >/dev/null

# One line per movie with a file: movieId <TAB> movieFileId <TAB> path <TAB> title (year)
movies="$(api GET movie | jq -r '.[] | select(.hasFile and .movieFile != null)
  | [.id, .movieFile.id, (.movieFile.path // ((.path // "") + "/" + (.movieFile.relativePath // ""))),
     "\(.title) (\(.year))"] | @tsv')"

total=0 checked=0 skipped=0
corrupt=()
now="$(date +%s)"
while IFS=$'\t' read -r movie_id file_id path title; do
  [ -n "${movie_id:-}" ] || continue
  total=$((total + 1))
  if [ ! -f "$path" ]; then
    log "skip (missing on disk): ${title}: ${path}"
    skipped=$((skipped + 1))
    continue
  fi
  mtime="$(stat -c %Y "$path")"
  if [ $(((now - mtime) / 60)) -lt "$MIN_AGE_MINUTES" ]; then
    log "skip (changed in the last ${MIN_AGE_MINUTES}m): ${title}"
    skipped=$((skipped + 1))
    continue
  fi
  rc=0
  reason="$(check_file "$path")" || rc=$?
  if [ "$rc" -eq 2 ]; then
    log "skip (probe timed out after ${PROBE_TIMEOUT}s): ${title}"
    skipped=$((skipped + 1))
    continue
  fi
  checked=$((checked + 1))
  if [ -n "$reason" ]; then
    log "CORRUPT: ${title}: ${path}: ${reason}"
    corrupt+=("${movie_id}"$'\t'"${file_id}"$'\t'"${title}")
  fi
done <<<"$movies"

log "movies with files: ${total}, checked: ${checked}, skipped: ${skipped}, corrupt: ${#corrupt[@]}"

if [ "${#corrupt[@]}" -eq 0 ]; then
  exit 0
fi
if [ "${#corrupt[@]}" -gt "$MAX_DELETIONS" ]; then
  log "ERROR: ${#corrupt[@]} corrupt files exceed MAX_DELETIONS=${MAX_DELETIONS}; deleting nothing."
  log "This usually means a storage fault, not corruption. Check the movies mount, then rerun or raise MAX_DELETIONS."
  exit 1
fi

failures=0
search_ids=()
for entry in "${corrupt[@]}"; do
  IFS=$'\t' read -r movie_id file_id title <<<"$entry"
  if [ "$DRY_RUN" = "true" ]; then
    log "dry run: would blocklist, delete movie file ${file_id} and search: ${title}"
    continue
  fi

  if [ "$BLOCKLIST_RELEASE" = "true" ]; then
    # Most recent grab (eventType 1) of this movie; failing it adds the release to
    # the blocklist. Best effort: a manually imported file has no grab.
    history_id="$(api GET "history/movie?movieId=${movie_id}&eventType=1" 2>/dev/null \
      | jq -r 'sort_by(.date) | last | .id // empty' 2>/dev/null || true)"
    if [ -n "$history_id" ]; then
      if api POST "history/failed/${history_id}" >/dev/null; then
        log "blocklisted release (history ${history_id}): ${title}"
      else
        log "WARN: could not blocklist release (history ${history_id}): ${title}"
      fi
    else
      log "no grab in history to blocklist: ${title}"
    fi
  fi

  if api DELETE "moviefile/${file_id}" >/dev/null; then
    log "deleted movie file ${file_id}: ${title}"
    search_ids+=("$movie_id")
  else
    log "ERROR: could not delete movie file ${file_id}: ${title}"
    failures=$((failures + 1))
  fi
done

if [ "${#search_ids[@]}" -gt 0 ]; then
  ids_json="$(printf '%s\n' "${search_ids[@]}" | jq -cs 'map(tonumber)')"
  if api POST command --data "{\"name\":\"MoviesSearch\",\"movieIds\":${ids_json}}" >/dev/null; then
    log "started automatic search for movie ids ${ids_json}"
  else
    log "ERROR: could not start the automatic search for movie ids ${ids_json}"
    failures=$((failures + 1))
  fi
fi

[ "$failures" -eq 0 ]
