#!/usr/bin/env bash
# Start Google Chrome with remote debugging for AI SNS Manager (Playwright CDP).
# Dedicated worker profile — never the user's default Chrome profile.
# Runs headless / background so action windows are not visible on screen.
#
# Usage:
#   ./scripts/start-cdp-chrome.sh
#   CDP_PORT=9222 CDP_USER_DATA_DIR="$HOME/ai-sns-manager/chrome-profile" ./scripts/start-cdp-chrome.sh
#
# Login once (visible, optional):
#   CDP_HEADLESS=0 ./scripts/start-cdp-chrome.sh
#   then open Naver and sign in — session persists in CDP_USER_DATA_DIR.
#
# See: docs/cdp-auto-start-mac.md

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
CDP_HOST="${CDP_HOST:-127.0.0.1}"
# Worker-only profile (avoid ~/Library/Application Support/Google/Chrome and ~/chrome-cdp-profile conflicts)
CDP_USER_DATA_DIR="${CDP_USER_DATA_DIR:-${HOME}/ai-sns-manager/chrome-profile}"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CDP_URL="http://${CDP_HOST}:${CDP_PORT}"
# Default: headless for ops. Set CDP_HEADLESS=0 for first-time Naver login.
CDP_HEADLESS="${CDP_HEADLESS:-1}"
LOCK_FILE="${CDP_USER_DATA_DIR}/SingletonLock"

log() {
  printf '[cdp-chrome] %s\n' "$*"
}

if [[ ! -x "$CHROME_BIN" ]]; then
  log "ERROR: Chrome not found at: $CHROME_BIN"
  log "Install Google Chrome or set CHROME_BIN to the binary path."
  exit 1
fi

# Already listening? Reuse (keeps Naver session / open tabs). Do NOT launch a second Chrome on the same profile.
if curl -fsS --max-time 2 "${CDP_URL}/json/version" >/dev/null 2>&1; then
  log "Already running: ${CDP_URL} (reuse session — skip launch)"
  log "  profile=${CDP_USER_DATA_DIR}"
  exit 0
fi

mkdir -p "$CDP_USER_DATA_DIR"

# Profile lock left behind after crash can trigger:
# "Chrome에서 프로필을 여는 동안 문제가 발생했습니다"
if [[ -e "$LOCK_FILE" ]] || [[ -L "$LOCK_FILE" ]]; then
  # If another Chrome holds this profile but CDP is down, refuse to launch a second instance.
  if pgrep -fl "user-data-dir=${CDP_USER_DATA_DIR}" >/dev/null 2>&1; then
    log "ERROR: profile lock held by another Chrome process for:"
    log "  ${CDP_USER_DATA_DIR}"
    log "Close that Chrome (or free port ${CDP_PORT}) before starting CDP worker Chrome."
    exit 1
  fi
  log "WARN: stale profile lock detected — removing ${LOCK_FILE}"
  rm -f "$LOCK_FILE" \
    "${CDP_USER_DATA_DIR}/SingletonCookie" \
    "${CDP_USER_DATA_DIR}/SingletonSocket" 2>/dev/null || true
fi

# Guard: never point at the default macOS Chrome profile
case "$CDP_USER_DATA_DIR" in
  *"/Library/Application Support/Google/Chrome"*)
    log "ERROR: refusing to use the default Chrome user profile (causes profile conflict)."
    log "Use a dedicated dir, e.g. \$HOME/ai-sns-manager/chrome-profile"
    exit 1
    ;;
esac

log "Starting Chrome (background / CDP worker)"
log "  CDP_URL=${CDP_URL}"
log "  user-data-dir=${CDP_USER_DATA_DIR}"
log "  headless=${CDP_HEADLESS}"

CHROME_ARGS=(
  --remote-debugging-port="${CDP_PORT}"
  --remote-debugging-address="${CDP_HOST}"
  --user-data-dir="${CDP_USER_DATA_DIR}"
  --no-first-run
  --no-default-browser-check
  --disable-sync
  --disable-features=ChromeWhatsNewUI
  --disable-background-networking
)

if [[ "$CDP_HEADLESS" == "1" || "$CDP_HEADLESS" == "true" ]]; then
  # new headless keeps CDP + login cookies more reliably than old --headless
  CHROME_ARGS+=(--headless=new --window-size=1280,720 --hide-scrollbars)
else
  # Off-screen fallback when headless must be off (rare login debugging)
  CHROME_ARGS+=(--window-position=-32000,-32000 --window-size=1280,720)
fi

# Launch detached so launchd / Terminal can exit without killing Chrome.
nohup "$CHROME_BIN" \
  "${CHROME_ARGS[@]}" \
  about:blank \
  >/tmp/cdp-chrome.log 2>&1 &

# Wait until CDP endpoint is ready (max ~20s)
for _ in $(seq 1 40); do
  if curl -fsS --max-time 1 "${CDP_URL}/json/version" >/dev/null 2>&1; then
    log "Ready: ${CDP_URL}/json/version"
    log "Profile lock OK — CDP connected (Chrome stays background)."
    exit 0
  fi
  sleep 0.5
done

log "ERROR: Chrome started but CDP did not answer at ${CDP_URL}"
log "Check /tmp/cdp-chrome.log"
log "Common causes:"
log "  - profile lock / another Chrome using the same user-data-dir"
log "  - port ${CDP_PORT} already taken by a non-CDP process"
log "  - corrupted profile → move ${CDP_USER_DATA_DIR} aside and re-login with CDP_HEADLESS=0"
exit 1
