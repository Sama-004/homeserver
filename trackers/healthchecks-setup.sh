#!/usr/bin/env bash
# Creates or updates one healthchecks.io check per docker-compose.yml service that sets
# HC_SLUG: timeout = that tracker's watch.intervalMinutes, grace = GRACE_S, alerts to every
# integration in the project. Safe to re-run: it upserts by slug.
# A check that has never been pinged stays "new" and never alerts, so this pings each new
# check once: a tracker that is already failing then gets reported after timeout + grace.
# Run on the server from anywhere: it reads HC_API_KEY (a read-write API key from the
# project's settings) from the environment or from trackers/.env.
set -euo pipefail
cd "$(dirname "$0")"

GRACE_S=7200
API="${HC_API_URL:-https://healthchecks.io}/api/v3/checks/"

key="${HC_API_KEY:-$(sed -n 's/^HC_API_KEY=//p' .env 2>/dev/null | tail -n 1)}"
[ -n "$key" ] || { echo "HC_API_KEY is not set: add it to trackers/.env" >&2; exit 1; }

services=$(docker compose config --format json | jq -r '
  .services[] | select(.environment.HC_SLUG)
  | [.environment.HC_SLUG, (.volumes[] | select(.target == "/app/config.json") | .source)]
  | @tsv')

resp=$(mktemp)
trap 'rm -f "$resp"' EXIT
failed=0
printf '%-18s %8s %6s  %s\n' slug timeout grace status
while IFS=$'\t' read -r slug config; do
  timeout=$(( $(jq -er '.watch.intervalMinutes' "$config") * 60 ))
  body=$(jq -nc --arg slug "$slug" --argjson timeout "$timeout" --argjson grace "$GRACE_S" '{
    name: $slug, slug: $slug, timeout: $timeout, grace: $grace,
    channels: "*", tags: "homeserver trackers", unique: ["slug"]}')
  # The key goes in through a file descriptor so it never shows up in `ps`.
  code=$(curl -sS -o "$resp" -w '%{http_code}' --max-time 20 \
    -H @<(printf 'X-Api-Key: %s\n' "$key") -H 'Content-Type: application/json' \
    --data-binary "$body" "$API") || code=000
  case "$code" in
    201) status=created ;;
    200) status=updated ;;
    *) status="error $code: $(head -c 200 "$resp")"; failed=1 ;;
  esac
  if [[ $code == 20[01] && $(jq -r .status "$resp") == new ]]; then
    if curl -fsS -o /dev/null --max-time 20 "$(jq -r .ping_url "$resp")"; then
      status+=", first ping sent"
    else
      status+=", first ping failed"; failed=1
    fi
  fi
  printf '%-18s %7ss %5ss  %s\n' "$slug" "$timeout" "$GRACE_S" "$status"
done <<<"$services"
exit "$failed"
