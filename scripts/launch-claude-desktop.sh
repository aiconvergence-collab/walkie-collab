#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${HOME}/.cache"
CDP_URL="${CLAUDE_CDP_URL:-http://127.0.0.1:9222}"
PROFILE_DIR="${CLAUDE_CDP_PROFILE:-${HOME}/.cache/claude-walkie-cdp}"
CHROME_ADDR="${CLAUDE_CDP_ADDR:-127.0.0.1}"
CHROME_BIN="${CLAUDE_CHROME_BIN:-}"
CDP_PORT="${CLAUDE_CDP_PORT:-}"
NODE_BIN=""

log() {
  local line="[claude-walkie] $*"
  printf '%s\n' "$line" >&2
  printf '%s %s\n' "$(date '+%F %T')" "$line" >> "${HOME}/.cache/claude-walkie-launch.log"
}

probe_cdp() {
  local json
  json="$(curl -fsS --max-time 1 "${CDP_URL}/json/version" 2>/dev/null || true)"
  if [[ "$json" == *\"webSocketDebuggerUrl\"* ]]; then
    return 0
  fi
  return 1
}

resolve_cdp_port() {
  if [[ -n "${CDP_PORT}" ]]; then
    echo "${CDP_PORT}"
    return
  fi

  local hostport="${CDP_URL#*://}"
  hostport="${hostport%%/*}"
  if [[ "$hostport" == *:* ]]; then
    echo "${hostport##*:}"
  else
    echo "9222"
  fi
}

CDP_PORT="$(resolve_cdp_port)"
if [[ -z "${CDP_PORT}" || ! "${CDP_PORT}" =~ ^[0-9]+$ ]]; then
  CDP_PORT=9222
fi

if command -v google-chrome >/dev/null 2>&1; then
  CHROME_BIN="google-chrome"
elif command -v google-chrome-stable >/dev/null 2>&1; then
  CHROME_BIN="google-chrome-stable"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN="chromium-browser"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="chromium"
else
  echo "Chrome/Chromium not found. Set CLAUDE_CHROME_BIN to your browser executable." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to wait for the CDP endpoint." >&2
  exit 1
fi
resolve_node_bin() {
  local candidate
  if [[ -n "${CLAUDE_NODE_BIN:-}" && -x "${CLAUDE_NODE_BIN}" ]]; then
    echo "${CLAUDE_NODE_BIN}"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    echo "$(command -v node)"
    return
  fi

  shopt -s nullglob
  for candidate in "${HOME}/.nvm/versions/node"/*/bin/node; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      shopt -u nullglob
      return
    fi
  done
  shopt -u nullglob

  for candidate in "${HOME}/.local/bin/node" "/usr/local/bin/node" "/usr/bin/node"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done

  echo ""
}

NODE_BIN="$(resolve_node_bin)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "node is required for launch to run walkie.mjs. Set CLAUDE_NODE_BIN to the node executable path." >&2
  exit 1
fi

if probe_cdp; then
  log "Attached to existing CDP session at ${CDP_URL}."
else
  log "No CDP endpoint at ${CDP_URL}; starting ${CHROME_BIN}."
  mkdir -p "${PROFILE_DIR}"
  cdpargs=(
    "--remote-debugging-address=${CHROME_ADDR}"
    "--remote-debugging-port=${CDP_PORT}"
    "--user-data-dir=${PROFILE_DIR}"
    "--no-first-run"
    "--no-default-browser-check"
    "--new-window"
    "https://claude.ai/new"
  )

  if setsid "${CHROME_BIN}" "${cdpargs[@]}" >/tmp/claude-walkie-chrome.log 2>&1 &
  then
    log "Chrome started with profile ${PROFILE_DIR} (pid: $!)."
  else
    echo "Failed to start Chrome. See /tmp/claude-walkie-chrome.log for details." >&2
    exit 1
  fi
fi

log "Waiting for CDP endpoint on ${CDP_URL} ..."
for _ in $(seq 1 120); do
  if probe_cdp; then
    log "CDP endpoint is ready."
    break
  fi
  sleep 0.5
done

if ! probe_cdp; then
  echo "Timed out waiting for Chrome remote debugging at ${CDP_URL}." >&2
  echo "If you already have another Chrome using --remote-debugging-port=${CDP_PORT}, close it and retry." >&2
  echo "Inspect /tmp/claude-walkie-chrome.log for startup errors." >&2
  exit 1
fi

exec "${NODE_BIN}" "${ROOT_DIR}/walkie.mjs" --cdp-url "${CDP_URL}" "$@"
