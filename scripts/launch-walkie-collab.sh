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

ask_subject() {
  local subject="${WALKIE_COLLAB_SUBJECT:-}"
  if [[ -z "${subject}" ]]; then
    read -rp "Subject for the selected local model and Claude to discuss: " subject
  fi
  if [[ -z "${subject// }" ]]; then
    echo "A subject is required." >&2
    exit 1
  fi
  printf '%s' "${subject}"
}

select_model() {
  local model="${WALKIE_COLLAB_LOCAL_MODEL:-}"
  local model_selector="${WALKIE_COLLAB_MODEL_SELECTOR:-${ROOT_DIR}/scripts/select-local-model.sh}"
  if [[ -n "${model}" ]]; then
    printf '%s' "${model}"
    return
  fi
  if [[ -z "${model_selector}" ]]; then
    echo "A local model or model selector is required." >&2
    exit 1
  fi
  "${model_selector}"
}

run_collab() {
  cd "${ROOT_DIR}"
  local local_model local_selection subject stamp transcript seed
  local local_args=()
  echo "Walkie Collab"
  echo
  local_selection="$(select_model)"
  if [[ "${local_selection}" == *"|"*"|"* ]]; then
    WALKIE_COLLAB_LOCAL_PROVIDER="${local_selection%%|*}"
    local_selection="${local_selection#*|}"
    WALKIE_COLLAB_LOCAL_URL="${local_selection%%|*}"
    local_model="${local_selection#*|}"
    export WALKIE_COLLAB_LOCAL_PROVIDER WALKIE_COLLAB_LOCAL_URL
  else
    local_model="${local_selection}"
  fi
  if [[ -z "${local_model// }" ]]; then
    echo "A local model is required." >&2
    exit 1
  fi
  echo "Selected local model: ${local_model}"
  if [[ -n "${WALKIE_COLLAB_LOCAL_PROVIDER:-}" || -n "${WALKIE_COLLAB_LOCAL_URL:-}" ]]; then
    echo "Local provider: ${WALKIE_COLLAB_LOCAL_PROVIDER:-auto}"
    echo "Local endpoint: ${WALKIE_COLLAB_LOCAL_URL:-auto}"
  fi
  echo
  subject="$(ask_subject)"
  stamp="$(date +%Y%m%d-%H%M%S)"
  transcript="${ROOT_DIR}/.cache/collab/collab-${stamp}.jsonl"
  mkdir -p "$(dirname "${transcript}")"
  seed="Subject: ${subject}. The selected local model and Claude should chat as research collaborators for two hours. Explore the topic from multiple angles, challenge weak claims, and keep each turn concise enough for a human operator to follow. Use plain text notation. Be cautious and do not claim conclusions without explicit defensible steps. No tools."

  echo
  echo "Transcript: ${transcript}"
  echo

  if [[ -n "${WALKIE_COLLAB_LOCAL_PROVIDER:-}" ]]; then
    local_args+=(--local-provider "${WALKIE_COLLAB_LOCAL_PROVIDER}")
  fi
  if [[ -n "${WALKIE_COLLAB_LOCAL_URL:-}" ]]; then
    local_args+=(--local-url "${WALKIE_COLLAB_LOCAL_URL}")
  fi

  exec "${NODE_BIN}" "${ROOT_DIR}/collab-cli.mjs" \
    --mode claude-live \
    --local-model "${local_model}" \
    "${local_args[@]}" \
    --turns "${WALKIE_COLLAB_TURNS:-2000}" \
    --duration-minutes "${WALKIE_COLLAB_DURATION_MINUTES:-120}" \
    --delay-ms "${WALKIE_COLLAB_DELAY_MS:-5000}" \
    --local-max-tokens "${WALKIE_COLLAB_LOCAL_MAX_TOKENS:-260}" \
    --local-timeout-ms "${WALKIE_COLLAB_LOCAL_TIMEOUT_MS:-240000}" \
    --token-budget "${WALKIE_COLLAB_TOKEN_BUDGET:-240000}" \
    --transcript "${transcript}" \
    --seed "${seed}"
}

if [[ "${WALKIE_COLLAB_IN_TERMINAL:-0}" == "1" ]]; then
  run_collab
fi

if command -v gnome-terminal >/dev/null 2>&1; then
  exec gnome-terminal \
    --title="Walkie Collab" \
    --working-directory="${ROOT_DIR}" \
    -- bash -lc 'export WALKIE_COLLAB_IN_TERMINAL=1; "$0"; rc=$?; echo; read -rp "Session ended. Press Enter to close..." _; exit "$rc"' \
    "${BASH_SOURCE[0]}"
fi

if command -v x-terminal-emulator >/dev/null 2>&1; then
  exec x-terminal-emulator -T "Walkie Collab" -e bash -lc \
    'export WALKIE_COLLAB_IN_TERMINAL=1; "'"${BASH_SOURCE[0]}"'"; rc=$?; echo; read -rp "Session ended. Press Enter to close..." _; exit "$rc"'
fi

run_collab
