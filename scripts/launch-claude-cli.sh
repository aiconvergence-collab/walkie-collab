#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${CLAUDE_NODE_BIN:-}"

if [[ -z "${NODE_BIN}" ]]; then
  shopt -s nullglob
  for candidate in \
    "${HOME}/.nvm/versions/node"/*/bin/node \
    "${HOME}/.local/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"; do
    if [[ -x "${candidate}" ]]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
  shopt -u nullglob
fi

if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [[ -z "${NODE_BIN}" ]]; then
  echo "Node.js is required. Set CLAUDE_NODE_BIN to your node executable." >&2
  exit 1
fi

cd "${ROOT_DIR}"

if command -v gnome-terminal >/dev/null 2>&1; then
  exec gnome-terminal \
    --title="Claude Walkie Console" \
    --working-directory="${ROOT_DIR}" \
    -- bash -c '"$@"; rc=$?; echo; read -rp "Press Enter to close..." _; exit "$rc"' \
    -- "${NODE_BIN}" "${ROOT_DIR}/claude-cli.mjs" "$@"
fi

exec "${NODE_BIN}" "${ROOT_DIR}/claude-cli.mjs" "$@"
