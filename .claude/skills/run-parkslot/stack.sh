#!/usr/bin/env bash
# Starts or stops a throwaway ParkSlot server and a headless Firefox that driver.mjs talks to.
#   stack.sh up     server on $PORT with a fresh DB, Firefox with a fresh profile on $BIDI_PORT
#   stack.sh down   stops both (only the processes this script started)
# Run from the ParkSlot directory. Never touches data/parking.db or a dev server on port 3000.
set -euo pipefail

PORT=${PORT:-3123}
BIDI_PORT=${BIDI_PORT:-9333}
FAKE_TRAFFIC_PORT=${FAKE_TRAFFIC_PORT:-4555}
SKILL_DIR=$(cd "$(dirname "$0")" && pwd)
RUN_DIR=${PARKSLOT_RUN_DIR:-${TMPDIR:-/tmp}/parkslot-run}

stop_all() {
  # Firefox: match on our own profile path so a personal Firefox is never killed.
  pkill -f -- "--profile $RUN_DIR/ffprofile" 2>/dev/null || true
  # lsof exits 1 when nothing is listening, which would end the script under pipefail.
  { lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null || true; } | xargs -r kill
  { lsof -ti:"$FAKE_TRAFFIC_PORT" -sTCP:LISTEN 2>/dev/null || true; } | xargs -r kill
  sleep 1
}

case "${1:-}" in
  up)
    stop_all
    # HTTPS_PORT is passed through to the server; the user's own dev server may already hold it.
    if [ -n "${HTTPS_PORT:-}" ] && lsof -ti:"$HTTPS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "HTTPS_PORT $HTTPS_PORT is already in use (probably the user's npm run dev). Pick another, e.g. HTTPS_PORT=3444." >&2
      exit 1
    fi
    rm -rf "$RUN_DIR" && mkdir -p "$RUN_DIR/ffprofile" "$RUN_DIR/shots"
    if [ "${FAKE_CAMERA:-}" = 1 ]; then
      # A synthetic camera and no permission prompt, so getUserMedia works headless (the admin scanner).
      printf '%s\n' 'user_pref("media.navigator.streams.fake", true);' \
        'user_pref("media.navigator.permission.disabled", true);' > "$RUN_DIR/ffprofile/user.js"
    fi
    if [ "${FAKE_TRAFFIC:-}" = 1 ]; then
      # A local stand-in for TomTom's traffic API, so lots get traffic-based prices without a real key.
      nohup node "$SKILL_DIR/fake-tomtom.mjs" "$FAKE_TRAFFIC_PORT" > "$RUN_DIR/fake-tomtom.log" 2>&1 &
      export TOMTOM_API_KEY=fake-key TOMTOM_BASE_URL="http://127.0.0.1:$FAKE_TRAFFIC_PORT"
    fi
    # A fresh DB auto-seeds a lot near every Delhi metro station, the demo driver and the demo admin.
    DB_FILE="$RUN_DIR/parking.db" PORT="$PORT" nohup node src/server.js > "$RUN_DIR/server.log" 2>&1 &
    # about:blank: otherwise the first tab loads the distro's start page, whose console errors
    # (e.g. Fedora's "Hydration completed but contains mismatches") show up in the driver's output.
    nohup firefox --headless --no-remote --profile "$RUN_DIR/ffprofile" \
      --remote-debugging-port="$BIDI_PORT" about:blank > "$RUN_DIR/firefox.log" 2>&1 &
    timeout 30 bash -c "until curl -sf http://localhost:$PORT/api/config >/dev/null; do sleep 0.3; done" \
      || { echo "server did not start:"; cat "$RUN_DIR/server.log"; exit 1; }
    if [ -n "${HTTPS_PORT:-}" ]; then
      timeout 30 bash -c "until curl -skf https://localhost:$HTTPS_PORT/api/config >/dev/null; do sleep 0.3; done" \
        || { echo "HTTPS did not start:"; cat "$RUN_DIR/server.log"; exit 1; }
    fi
    timeout 30 bash -c "until grep -q 'WebDriver BiDi listening' '$RUN_DIR/firefox.log'; do sleep 0.3; done" \
      || { echo "firefox did not start:"; cat "$RUN_DIR/firefox.log"; exit 1; }
    echo "app:     http://localhost:$PORT  (admin: http://localhost:$PORT/admin/)"
    echo "bidi:    ws://127.0.0.1:$BIDI_PORT"
    echo "run dir: $RUN_DIR  (parking.db, server.log, firefox.log, shots/)"
    ;;
  down)
    stop_all
    echo "stopped"
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
