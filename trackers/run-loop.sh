#!/bin/sh
# The long-lived process of every tracker container (docker-compose.yml mounts this file
# and runs it). Node only exists during a check: `node tracker.mjs --once` checks, writes
# the unix time (seconds) of its next check to `next-run` next to its state file, and
# exits; this loop sleeps until then. POSIX sh: busybox ash (alpine) and dash (Ubuntu).
#
# Env: CYCLE_TIMEOUT (s, default 300) kills a wedged check; FALLBACK_SLEEP (s, default
# 300) is the wait when a check exits without scheduling the next one.

NEXT_RUN="$(dirname "${STATE_PATH:-state.json}")/next-run"
CYCLE_TIMEOUT="${CYCLE_TIMEOUT:-300}"
FALLBACK_SLEEP="${FALLBACK_SLEEP:-300}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# sh as PID 1 ignores SIGTERM unless trapped, and a trap only fires once the foreground
# command returns, so everything long runs in the background under `wait`. That makes
# `docker stop` instant instead of a 10 s wait for SIGKILL.
trap 'exit 0' TERM INT

while :; do
  rm -f "$NEXT_RUN"
  timeout -s KILL "$CYCLE_TIMEOUT" node tracker.mjs --once &
  wait $!
  status=$?
  if [ "$status" -ne 0 ]; then
    log "check exited with status $status"
    # Playwright starts Chromium in its own process group, so killing node leaves it
    # running. As the container's PID 1, kill whatever the failed check left behind.
    [ $$ -ne 1 ] || kill -KILL -1 2>/dev/null
  fi

  next=$(cat "$NEXT_RUN" 2>/dev/null)
  case "$next" in
    '' | *[!0-9]*) wait_s=$FALLBACK_SLEEP ;;
    *)
      wait_s=$((next - $(date +%s)))
      [ "$wait_s" -ge 30 ] || wait_s=30
      ;;
  esac
  log "next check in ${wait_s}s"
  sleep "$wait_s" &
  wait $!
done
