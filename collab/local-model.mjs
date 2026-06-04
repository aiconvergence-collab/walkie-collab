import { formatTranscript } from "./transcript.mjs";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TIMEOUT_MS = 300000;

function inferProvider(endpoint, explicitProvider = "") {
  if (explicitProvider) return explicitProvider;
  return /\/v1(?:\/chat\/completions)?\/?$/i.test(String(endpoint || "")) ? "openai" : "ollama";
}

function normalizeEndpoint(endpoint, provider) {
  const value = String(endpoint || "").replace(/\/+$/, "");
  if (provider === "openai") {
    if (/\/v1\/chat\/completions$/i.test(value)) return value;
    if (/\/v1$/i.test(value)) return `${value}/chat/completions`;
    return `${value}/v1/chat/completions`;
  }
  return value || DEFAULT_OLLAMA_URL;
}

function modelsEndpoint(chatEndpoint, provider) {
  const value = String(chatEndpoint || "").replace(/\/+$/, "");
  if (provider === "openai") {
    return value.replace(/\/v1\/chat\/completions$/i, "/v1/models");
  }
  return value.replace(/\/api\/chat$/i, "/api/tags");
}

async function readJsonWithTimeout(response, controller) {
  try {
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Local model response timed out while reading the response body.");
    }
    throw error;
  }
}

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
    const endpoint =
      options.endpoint ||
      process.env.WALKIE_COLLAB_LOCAL_URL ||
      process.env.CANAL_API_URL ||
      process.env.OLLAMA_CHAT_URL ||
      DEFAULT_OLLAMA_URL;
    this.provider = inferProvider(endpoint, options.provider || process.env.WALKIE_COLLAB_LOCAL_PROVIDER || "");
    this.endpoint = normalizeEndpoint(endpoint, this.provider);
    this.apiKey = options.apiKey || process.env.WALKIE_COLLAB_LOCAL_API_KEY || process.env.CANAL_API_KEY || "";
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
    const provider = inferProvider(chatEndpoint);
    return modelsEndpoint(normalizeEndpoint(chatEndpoint, provider), provider);
  }

  static async listAvailableModels(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (!fetchImpl) throw new Error("fetch is not available in this Node.js runtime.");
    const rawEndpoint =
      options.endpoint ||
      process.env.WALKIE_COLLAB_LOCAL_URL ||
      process.env.CANAL_API_URL ||
      process.env.OLLAMA_CHAT_URL ||
      DEFAULT_OLLAMA_URL;
    const provider = inferProvider(rawEndpoint, options.provider || process.env.WALKIE_COLLAB_LOCAL_PROVIDER || "");
    const endpoint = modelsEndpoint(normalizeEndpoint(rawEndpoint, provider), provider);
    const apiKey = options.apiKey || process.env.WALKIE_COLLAB_LOCAL_API_KEY || process.env.CANAL_API_KEY || "";
    const headers = provider === "openai" && apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const response = await fetchImpl(endpoint, { method: "GET", headers });
    if (!response?.ok) {
      const body = await response?.text?.().catch(() => "");
      throw new Error(`Local model list failed: HTTP ${response?.status || "unknown"} ${body}`.trim());
    }
    const data = await response.json();
    if (provider === "openai" && Array.isArray(data?.data)) {
      return data.data.map((model) => ({ name: model.id || model.model })).filter((model) => model.name);
    }
    return Array.isArray(data?.models) ? data.models : [];
  }

  static chooseModel(models, preferred = "") {
    const names = models.map((model) => model.name || model.model).filter(Boolean);
    if (preferred && names.includes(preferred)) return preferred;
    const ranked = [
      /^qwen3-next:80b$/i,
      /^gemma4:(31b|26b)$/i,
      /qwen3-next:80b-cloud/i,
      /gemma4:31b-cloud/i,
      /cogito-.*cloud/i,
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
    let data;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.provider === "openai" && this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify(this.provider === "openai"
          ? {
              model: this.model,
              stream: false,
              messages,
              max_tokens: this.maxTokens,
              temperature: this.temperature,
              stop: ["<|endoftext|>", "<|im_start|>user", "\nNext speaker:", "\nTranscript:"],
            }
          : {
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
      if (!response?.ok) {
        const body = await response?.text?.().catch(() => "");
        throw new Error(`Local model request failed: HTTP ${response?.status || "unknown"} ${body}`.trim());
      }
      data = await readJsonWithTimeout(response, controller);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Local model request timed out after ${this.requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const content = cleanLocalResponse(data?.choices?.[0]?.message?.content ?? data?.message?.content ?? data?.response ?? "");
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
