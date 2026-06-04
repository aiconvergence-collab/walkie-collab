import { formatTranscript } from "./transcript.mjs";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TIMEOUT_MS = 300000;

function roleSystemPrompt(role) {
  if (role === "local_peer") {
    return [
      "/no_think",
      "You are LOCAL_PEER in a bounded collaboration session.",
      "You are a second local persona responding to LOCAL_MODEL.",
      "Stay on topic, avoid loops, and do not ask for shell/file tools.",
      "Respond in one concise conversational turn.",
      "Use plain text math notation, not LaTeX.",
      "Do not include speaker labels, transcript markup, hidden thinking, or control tokens.",
    ].join("\n");
  }

  return [
    "/no_think",
    "You are LOCAL_MODEL in a bounded collaboration session.",
    "You may be talking with Claude through a local wrapper.",
    "Stay on topic, avoid loops, and do not ask for shell/file tools.",
    "Respond in one concise conversational turn.",
    "Use plain text math notation, not LaTeX.",
    "Do not include speaker labels, transcript markup, hidden thinking, or control tokens.",
  ].join("\n");
}

function cleanLocalResponse(text) {
  let value = String(text || "");
  value = value.replace(/<think>[\s\S]*?<\/think>/gi, "");
  value = value.replace(/<think>[\s\S]*$/gi, "");
  value = value.replace(/<\|[^>]+?\|>/g, "");
  const speakerBlocks = [
    ...value.matchAll(
      /(?:^|\n)\s*(?:\[?(qwen|wen|local(?:_model|_peer)?|assistant)\]?)\s*:?\s*([\s\S]*?)(?=\n\s*(?:\[?(?:claude|qwen|wen|local(?:_model|_peer)?|assistant)\]?)\s*:|\n\s*\[(?:claude|local|qwen|seed)[^\]]*\]|\n\s*(?:Respond as|Write only|Transcript:|User seed prompt:)|$)/gi,
    ),
  ];
  if (speakerBlocks.length) value = speakerBlocks.at(-1)[2];
  const qwenMatch = /^\s*\[(?:qwen|local(?:_model|_peer)?)\]\s*([\s\S]*?)(?=\n\s*\[(?:claude|local|qwen|seed)[^\]]*\]|\n\s*(?:Respond as|Write only|Transcript:|User seed prompt:)|$)/i.exec(value);
  if (qwenMatch) value = qwenMatch[1];
  value = value.replace(/^[_-]?(qwen|local_model|local_peer|assistant)\s*:?\s*/i, "");
  value = value.replace(/^\s*\[(?:qwen|local(?:_model|_peer)?|assistant)\]\s*/i, "");
  value = value
    .split("\n")
    .filter((line) => !/^\s*(start with|no previous messages|do not continue)\b/i.test(line))
    .filter((line) => !/^\s*do not (write|use|include)\b/i.test(line))
    .filter((line) => !/^\s*assistant\s*:/i.test(line))
    .join("\n");
  value = value.replace(/^\s*:\s*/, "");
  value = value.replace(/\n\s*(next speaker|transcript|user seed prompt|respond as|write only)\s*[:\w\s]*[\s\S]*$/i, "");
  value = value.replace(/\n\s*\[(?:claude|local|qwen|seed)[^\]]*\][\s\S]*$/i, "");
  value = value.trim();
  return value;
}

export class LocalModelClient {
  constructor(options = {}) {
    this.model = options.model || "deepseek-r1:latest";
    this.endpoint = options.endpoint || process.env.OLLAMA_CHAT_URL || DEFAULT_OLLAMA_URL;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.maxTokens = Number(options.maxTokens ?? process.env.OLLAMA_NUM_PREDICT ?? DEFAULT_MAX_TOKENS);
    this.temperature = Number(options.temperature ?? process.env.OLLAMA_TEMPERATURE ?? 0.4);
    this.requestTimeoutMs = Number(options.requestTimeoutMs ?? process.env.OLLAMA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    if (!this.fetchImpl) throw new Error("fetch is not available in this Node.js runtime.");
    if (!Number.isFinite(this.maxTokens) || this.maxTokens <= 0) throw new Error("Local max tokens must be positive.");
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Local request timeout must be positive.");
    }
  }

  static tagsEndpoint(chatEndpoint = DEFAULT_OLLAMA_URL) {
    return String(chatEndpoint).replace(/\/api\/chat\/?$/, "/api/tags");
  }

  static async listAvailableModels(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (!fetchImpl) throw new Error("fetch is not available in this Node.js runtime.");
    const endpoint = this.tagsEndpoint(options.endpoint || process.env.OLLAMA_CHAT_URL || DEFAULT_OLLAMA_URL);
    const response = await fetchImpl(endpoint, { method: "GET" });
    if (!response?.ok) {
      const body = await response?.text?.().catch(() => "");
      throw new Error(`Ollama model list failed: HTTP ${response?.status || "unknown"} ${body}`.trim());
    }
    const data = await response.json();
    return Array.isArray(data?.models) ? data.models : [];
  }

  static chooseModel(models, preferred = "") {
    const names = models.map((model) => model.name || model.model).filter(Boolean);
    if (preferred && names.includes(preferred)) return preferred;
    const ranked = [
      /qwen3-next:80b-cloud/i,
      /gemma4:31b-cloud/i,
      /cogito-.*cloud/i,
      /qwen3-next:80b/i,
      /gemma4:(31b|26b)/i,
      /qwen3\.6.*local/i,
      /qwen3\.6/i,
      /qwen3\.5.*35/i,
      /qwen2\.5.*coder/i,
      /phi3/i,
    ];
    for (const pattern of ranked) {
      const found = names.find((name) => pattern.test(name));
      if (found) return found;
    }
    return names[0] || preferred || "deepseek-r1:latest";
  }

  static async resolveModel(preferred = "", options = {}) {
    const models = await this.listAvailableModels(options);
    return this.chooseModel(models, preferred);
  }

  buildMessages(transcriptEntries, { speaker = "local", seed = "" } = {}) {
    const transcript = formatTranscript(transcriptEntries);
    const userContent = [
      "/no_think",
      seed ? `User seed prompt:\n${seed}` : "",
      "Transcript:",
      transcript,
      "",
      `Write only the next concise message from ${speaker}.`,
    ]
      .filter(Boolean)
      .join("\n");

    return [
      { role: "system", content: roleSystemPrompt(speaker) },
      { role: "user", content: userContent },
    ];
  }

  async ask(transcriptEntries, options = {}) {
    const messages = this.buildMessages(transcriptEntries, options);
    return this.#request(messages, false);
  }

  async #request(messages, retrying) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          messages,
          options: {
            num_predict: this.maxTokens,
            temperature: this.temperature,
            stop: ["<|endoftext|>", "<|im_start|>user", "\nNext speaker:", "\nTranscript:"],
          },
        }),
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Local model request timed out after ${this.requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response?.ok) {
      const body = await response?.text?.().catch(() => "");
      throw new Error(`Local model request failed: HTTP ${response?.status || "unknown"} ${body}`.trim());
    }

    const data = await response.json();
    const content = cleanLocalResponse(data?.message?.content ?? data?.response ?? "");
    if (!content && !retrying) {
      return this.#request([
        ...messages,
        {
          role: "user",
          content: "/no_think\nRetry with one short visible chat message only. No labels, no hidden thinking, no control tokens.",
        },
      ], true);
    }
    if (!content) throw new Error("Local model returned an empty response.");
    return content;
  }
}

export default LocalModelClient;
