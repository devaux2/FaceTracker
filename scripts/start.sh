#!/usr/bin/env bash
# Serve FaceTracker over http://localhost (needed for camera + live sync) and
# open the control panel + display. Works on macOS and Linux.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

PORT="${PORT:-8000}"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "Python 3 is required (or use any other static file server)." >&2
  exit 1
fi

echo "Serving $DIR at http://localhost:$PORT"
"$PY" -m http.server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
sleep 1

CONTROL="http://localhost:$PORT/control.html"
DISPLAY_URL="http://localhost:$PORT/display.html"
echo "Control panel : $CONTROL"
echo "Display       : $DISPLAY_URL"

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"            # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"  # Linux
  fi
}
open_url "$CONTROL"

echo
echo "Press Ctrl+C to stop the server."
wait $SERVER_PID
