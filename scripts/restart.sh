#!/usr/bin/env bash
set -euo pipefail

# Restart the Claude Website Chat server.
# Kills any process holding port 18765, waits for the port to free, then relaunches.

PORT="${CLAUDE_CHAT_APP_PORT:-18765}"
HOST="127.0.0.1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${HOME}/.cache/claude-website-chat.log"

log() {
  local line="[restart] $(date '+%F %T') $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >> "$LOG_FILE"
}

# 1. Try graceful restart via HTTP
if curl -fsS --max-time 2 -X POST "http://${HOST}:${PORT}/restart" >/dev/null 2>&1; then
  log "Sent restart request to running server on port ${PORT}."
  sleep 0.5
fi

# 2. Find and kill any process holding the port
log "Looking for processes on port ${PORT}..."
PID=$(ss -tlnp "sport = :${PORT}" 2>/dev/null | grep -Po 'pid=\K[0-9]+' | head -1 || true)

if [[ -z "${PID}" ]]; then
  # Try lsof as fallback
  PID=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)
fi

if [[ -n "${PID}" ]]; then
  log "Killing PID ${PID} holding port ${PORT}..."
  kill "${PID}" 2>/dev/null || true
  sleep 0.3
  # Force kill if still alive
  kill -9 "${PID}" 2>/dev/null || true
fi

# 3. Wait for port to free
for _ in $(seq 1 30); do
  if ! ss -tlnp "sport = :${PORT}" 2>/dev/null | grep -q ":${PORT}"; then
    log "Port ${PORT} is free."
    break
  fi
  sleep 0.2
done

# 4. Relaunch
log "Launching Claude Website Chat..."
exec bash "${ROOT_DIR}/scripts/launch-claude-desktop-ui.sh" "$@"
