const DEFAULT_STOP_PHRASES = ["DONE", "FINAL", "STOP", "END_SESSION"];

const TOOL_PATTERNS = [
  /<tool_?call\b/i,
  /"\s*(name|tool)\s*"\s*:\s*"\s*(shell|start_shell|read_file|write_file|edit_file|list_dir|mkdir|chmod|grep|glob|stat)\s*"/i,
  /\b(shell|start_shell|read_file|write_file|edit_file|list_dir|chmod|grep|glob)\s*(\(|:|\{)/i,
  /\b(run|execute|start)\s+(a\s+)?(shell|command|bash|terminal)\b/i,
  /\b(read|write|edit)\s+(the\s+)?(local\s+)?(file|path)\b/i,
];

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\brespond as claude in one concise turn\b/g, " ")
    .replace(/\bwrite only the next concise message from [a-z_]+\b/g, " ")
    .replace(/\bno previous messages\b/g, " ")
    .replace(/\bdo not continue claude s response\b/g, " ")
    .replace(/\\[a-z]+/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function jaccardSimilarity(a, b) {
  const left = new Set(normalizeText(a).split(" ").filter(Boolean));
  const right = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / (left.size + right.size - intersection);
}

function repeatedPhrase(text) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  const words = normalized.split(" ");
  const counts = new Map();
  for (let size = 4; size <= 10; size++) {
    for (let i = 0; i <= words.length - size; i++) {
      const phrase = words.slice(i, i + size).join(" ");
      if (phrase.length < 32) continue;
      const count = (counts.get(phrase) || 0) + 1;
      if (count >= 16) return phrase;
      counts.set(phrase, count);
    }
  }
  return "";
}

export class SafetyGovernor {
  constructor(options = {}) {
    this.maxTurns = Number(options.maxTurns || 20);
    this.tokenBudget = Number(options.tokenBudget || 32000);
    this.stopPhrases = options.stopPhrases || DEFAULT_STOP_PHRASES;

    if (!Number.isInteger(this.maxTurns) || this.maxTurns <= 0) {
      throw new Error("--turns must be a positive finite integer.");
    }
    if (!Number.isFinite(this.tokenBudget) || this.tokenBudget <= 0) {
      throw new Error("--token-budget must be a positive finite number.");
    }
  }

  inspectTurn(entry, transcriptEntries = []) {
    const content = String(entry?.content || "");
    const serviceLimit = this.detectServiceLimit(content);
    if (serviceLimit) {
      return {
        stop: true,
        reason: serviceLimit,
        speaker: entry.role,
      };
    }

    const toolRequest = this.detectToolRequest(content);
    if (toolRequest) {
      return {
        stop: true,
        reason: "tool_request_detected",
        detail: toolRequest,
        speaker: entry.role,
      };
    }

    const stopPhrase = this.detectStopPhrase(content);
    if (stopPhrase) {
      return {
        stop: true,
        reason: `stop_phrase:${stopPhrase}`,
        speaker: entry.role,
      };
    }

    const phrase = repeatedPhrase(content);
    if (phrase) {
      return {
        stop: true,
        reason: "repeated_phrase",
        detail: phrase,
        speaker: entry.role,
      };
    }

    return this.inspectTranscript(transcriptEntries);
  }

  inspectTranscript(entries = []) {
    const turns = entries.filter((entry) => entry.type === "turn");
    const tokens = turns.reduce((sum, entry) => sum + estimateTokens(entry.content), 0);
    if (tokens >= this.tokenBudget) {
      return { stop: true, reason: "token_budget_reached", detail: `${tokens}/${this.tokenBudget}` };
    }

    const last = turns.at(-1);
    const previous = turns.at(-2);
    if (last && previous && jaccardSimilarity(last.content, previous.content) >= 0.92) {
      return {
        stop: true,
        reason: "near_duplicate_turns",
        speaker: last.role,
      };
    }

    return { stop: false };
  }

  detectToolRequest(text) {
    const value = String(text || "");
    const match = TOOL_PATTERNS.find((pattern) => pattern.test(value));
    if (!match) return "";
    const line = value
      .split("\n")
      .find((candidate) => match.test(candidate)) || value.slice(0, 240);
    return line.trim().slice(0, 500);
  }

  detectStopPhrase(text) {
    const escaped = this.stopPhrases.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`^\\s*(${escaped.join("|")})\\s*[.!?]*\\s*$`, "im");
    return pattern.exec(String(text || ""))?.[1] || "";
  }

  detectServiceLimit(text) {
    const value = String(text || "");
    if (/\byou are out of free messages until\b/i.test(value)) return "claude_limit_reached";
    if (/^\s*session complete\.\s*nothing further to add\.?\s*$/i.test(value)) return "conversation_complete";
    return "";
  }
}

export default SafetyGovernor;
