#!/usr/bin/env bash
# Start Google Chrome with remote debugging for AI SNS Manager (Playwright CDP).
# Safe to run repeatedly: skips launch if port 9222 already answers.
#
# Usage:
#   ./scripts/start-cdp-chrome.sh
#   CDP_PORT=9222 CDP_USER_DATA_DIR="$HOME/chrome-cdp-profile" ./scripts/start-cdp-chrome.sh
#
# See: docs/cdp-auto-start-mac.md

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
CDP_HOST="${CDP_HOST:-127.0.0.1}"
CDP_USER_DATA_DIR="${CDP_USER_DATA_DIR:-${HOME}/chrome-cdp-profile}"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CDP_URL="http://${CDP_HOST}:${CDP_PORT}"

log() {
  printf '[cdp-chrome] %s\n' "$*"
}

if [[ ! -x "$CHROME_BIN" ]]; then
  log "ERROR: Chrome not found at: $CHROME_BIN"
  log "Install Google Chrome or set CHROME_BIN to the binary path."
  exit 1
fi

# Already listening? Reuse (keeps Naver session / open tabs).
if curl -fsS --max-time 2 "${CDP_URL}/json/version" >/dev/null 2>&1; then
  log "Already running: ${CDP_URL} (skip launch)"
  exit 0
fi

mkdir -p "$CDP_USER_DATA_DIR"

log "Starting Chrome"
log "  CDP_URL=${CDP_URL}"
log "  user-data-dir=${CDP_USER_DATA_DIR}"

# Dedicated profile only — do not use the default macOS Chrome profile path.
# Launch detached so launchd / Terminal can exit without killing Chrome.
nohup "$CHROME_BIN" \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address="${CDP_HOST}" \
  --user-data-dir="${CDP_USER_DATA_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  about:blank \
  >/tmp/cdp-chrome.log 2>&1 &

# Wait until CDP endpoint is ready (max ~20s)
for _ in $(seq 1 40); do
  if curl -fsS --max-time 1 "${CDP_URL}/json/version" >/dev/null 2>&1; then
    log "Ready: ${CDP_URL}/json/version"
    exit 0
  fi
  sleep 0.5
done

log "ERROR: Chrome started but CDP did not answer at ${CDP_URL}"
log "Check /tmp/cdp-chrome.log and that port ${CDP_PORT} is free."
exit 1
