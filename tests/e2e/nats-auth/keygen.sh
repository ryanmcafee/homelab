#!/bin/sh
# Mints a fresh user nkey per named principal into $SEEDS/<principal>.nk and prints
# `<principal>=<public key>` pairs, comma-separated. Seeds never leave the directory.
set -eu
: "${SEEDS:?SEEDS must name the directory the seeds are written to}"
mkdir -p "$SEEDS"
chmod 700 "$SEEDS"
pairs=""
for principal in "$@"; do
  seed="$SEEDS/$principal.nk"
  nats auth nkey gen user --output "$seed" >/dev/null
  chmod 600 "$seed"
  public=$(nats auth nkey show "$seed" | sed -n 's/^.*\(U[A-Z2-7]\{55\}\).*$/\1/p' | head -n 1)
  [ -n "$public" ] || { echo "no public key derived from $seed" >&2; exit 1; }
  pairs="${pairs:+$pairs,}$principal=$public"
done
printf '%s\n' "$pairs"
