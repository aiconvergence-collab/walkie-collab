#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="${CLAUDE_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
OLLAMA_CHAT_URL="${WALKIE_COLLAB_OLLAMA_URL:-${OLLAMA_CHAT_URL:-http://127.0.0.1:11434/api/chat}}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "Node.js is required to list local models." >&2
  exit 1
fi

mapfile -t MODELS < <("${NODE_BIN}" - "${OLLAMA_CHAT_URL}" <<'NODE'
const chatUrl = process.argv[2];
const tagsUrl = chatUrl.replace(/\/api\/chat\/?$/, "/api/tags");
try {
  const response = await fetch(tagsUrl);
  if (!response.ok) process.exit(2);
  const data = await response.json();
  for (const model of data.models || []) {
    const name = model.name || model.model;
    if (name) console.log(name);
  }
} catch {
  process.exit(2);
}
NODE
)

if [[ "${#MODELS[@]}" -eq 0 ]]; then
  echo "No Ollama models were listed. Type a model name/tag to use:" >&2
else
  echo "Choose a local model:" >&2
  local_index=1
  for model in "${MODELS[@]}"; do
    printf '  %d) %s\n' "${local_index}" "${model}" >&2
    local_index=$((local_index + 1))
  done
  echo "Or type any model name/tag manually." >&2
fi

choice=""
if [[ -r /dev/tty ]]; then
  read -r -p "Local model: " choice </dev/tty
else
  read -r choice
fi

if [[ "${choice}" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#MODELS[@]} )); then
  printf '%s\n' "${MODELS[$((choice - 1))]}"
elif [[ -n "${choice// }" ]]; then
  printf '%s\n' "${choice}"
elif [[ "${#MODELS[@]}" -gt 0 ]]; then
  printf '%s\n' "${MODELS[0]}"
else
  echo "A local model name is required." >&2
  exit 1
fi
