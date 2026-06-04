#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${HOME}/.cache/claude-free-tui.log"

# Resolve node, preferring nvm over system
NODE_BIN="${CLAUDE_NODE_BIN:-}"
if [[ -z "${NODE_BIN}" ]]; then
  for candidate in \
    "${HOME}/.nvm/versions/node"/*/bin/node \
    "${HOME}/.local/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "${NODE_BIN}" ]]; then
  echo "Node.js is required. Set CLAUDE_NODE_BIN env var." >&2
  exit 1
fi

cd "${ROOT_DIR}"

# Run the TUI inside gnome-terminal. Stderr goes to a log file for debugging.
# If the TUI exits with an error, the wrapper prints the error and waits for
# Enter so the user can read it before the terminal closes.
exec gnome-terminal \
  --title="Claude AI Free" \
  --working-directory="${ROOT_DIR}" \
  -- bash -c '
    "$@" 2>'"${LOG_FILE}"'; rc=$?
    if [ $rc -ne 0 ]; then
      echo >&2
      echo "── TUI exited with code $rc ──" >&2
      tail -20 '"${LOG_FILE}"' >&2 2>/dev/null || true
      echo >&2
      read -rp "Press Enter to close..." _
    fi
    exit $rc
  ' -- "${NODE_BIN}" "${ROOT_DIR}/claude-free-tui.mjs" "$@"
