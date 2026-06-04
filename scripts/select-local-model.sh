#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="${CLAUDE_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
OLLAMA_CHAT_URL="${WALKIE_COLLAB_OLLAMA_URL:-${OLLAMA_CHAT_URL:-http://127.0.0.1:11434/api/chat}}"
LOCAL_URL="${WALKIE_COLLAB_LOCAL_URL:-${CANAL_API_URL:-}}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "Node.js is required to list local models." >&2
  exit 1
fi

mapfile -t OPTIONS < <("${NODE_BIN}" - "${OLLAMA_CHAT_URL}" "${LOCAL_URL}" <<'NODE'
const ollamaChatUrl = process.argv[2];
const explicitLocalUrl = process.argv[3];
const preferred = [
  "qwen3-next:80b",
  "gemma4:26b",
  "gemma4:31b",
  "qwen3-next:80b-cloud",
  "gemma4:31b-cloud",
  "cogito-2.1:671b-cloud",
];
const rows = [];
const seen = new Set();

function add(label, spec) {
  if (!label || !spec || seen.has(spec)) return;
  seen.add(spec);
  rows.push([label, spec]);
}

function normalizeOpenAIChatUrl(value) {
  const trimmed = String(value || "").replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/v1\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

async function addOllama() {
  const tagsUrl = ollamaChatUrl.replace(/\/api\/chat\/?$/, "/api/tags");
  const response = await fetch(tagsUrl);
  if (!response.ok) return;
  const data = await response.json();
  const names = [];
  for (const model of data.models || []) {
    const name = model.name || model.model;
    if (name && !names.includes(name)) names.push(name);
  }
  const ranked = [
    ...preferred.filter((name) => names.includes(name)),
    ...names.filter((name) => !preferred.includes(name)),
  ];
  for (const name of ranked) add(`${name} (Ollama)`, `ollama|${ollamaChatUrl}|${name}`);
}

async function addOpenAI(baseUrl) {
  const chatUrl = normalizeOpenAIChatUrl(baseUrl);
  if (!chatUrl) return;
  const modelsUrl = chatUrl.replace(/\/v1\/chat\/completions$/i, "/v1/models");
  const response = await fetch(modelsUrl, {
    headers: process.env.CANAL_API_KEY ? { authorization: `Bearer ${process.env.CANAL_API_KEY}` } : {},
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) return;
  const data = await response.json();
  for (const model of data.data || []) {
    const name = model.id || model.model;
    if (name) add(`${name} (OpenAI-compatible ${modelsUrl.replace(/\/v1\/models$/i, "/v1")})`, `openai|${chatUrl}|${name}`);
  }
}

for (const url of [
  explicitLocalUrl,
  process.env.CANAL_API_URL,
  "http://127.0.0.1:8198/v1",
  "http://127.0.0.1:8193/v1",
  "http://127.0.0.1:8192/v1",
]) {
  await addOpenAI(url).catch(() => {});
}

add("Qwen 80B via Tribunal/Canal (:8198)", "openai|http://127.0.0.1:8198/v1/chat/completions|qwen80-canalw");
add("Gemma 4 26B via Canal (:8193)", "openai|http://127.0.0.1:8193/v1/chat/completions|gemma-4-26b");
add("Qwen Coder via Canal (:8192)", "openai|http://127.0.0.1:8192/v1/chat/completions|qwen2.5-coder-32b-canal");
await addOllama().catch(() => {});

for (const [label, spec] of rows) console.log(`${label}\t${spec}`);
NODE
)

LABELS=()
SPECS=()
for option in "${OPTIONS[@]}"; do
  label="${option%%$'\t'*}"
  spec="${option#*$'\t'}"
  if [[ -n "${label}" && -n "${spec}" && "${label}" != "${spec}" ]]; then
    LABELS+=("${label}")
    SPECS+=("${spec}")
  fi
done

if [[ "${#SPECS[@]}" -eq 0 ]]; then
  echo "No local model endpoints were listed. Type a model name/tag to use:" >&2
else
  echo "Choose a local model:" >&2
  local_index=1
  for label in "${LABELS[@]}"; do
    printf '  %d) %s\n' "${local_index}" "${label}" >&2
    local_index=$((local_index + 1))
  done
  echo "Or type any model tag manually." >&2
  echo "OpenAI-compatible manual form: openai|http://127.0.0.1:8198/v1/chat/completions|qwen80-canalw" >&2
fi

choice=""
if { exec 3</dev/tty; } 2>/dev/null; then
  read -r -p "Local model: " choice <&3 || true
  exec 3<&-
else
  read -r choice || true
fi

if [[ "${choice}" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#SPECS[@]} )); then
  printf '%s\n' "${SPECS[$((choice - 1))]}"
elif [[ -n "${choice// }" ]]; then
  printf '%s\n' "${choice}"
elif [[ "${#SPECS[@]}" -gt 0 ]]; then
  printf '%s\n' "${SPECS[0]}"
else
  echo "A local model name is required." >&2
  exit 1
fi
