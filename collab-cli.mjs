#!/usr/bin/env node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ClaudeFreeSession } from "./claude-free-api.mjs";
import { LocalModelClient } from "./collab/local-model.mjs";
import { CollabOrchestrator } from "./collab/orchestrator.mjs";
import { SafetyGovernor } from "./collab/safety-governor.mjs";
import { TranscriptStore } from "./collab/transcript.mjs";

const execFileAsync = promisify(execFile);

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

const VALID_MODES = new Set(["local-only", "claude-review", "claude-live"]);

function usage() {
  return `Usage:
  node collab-cli.mjs [options]

Options:
  --mode <local-only|claude-review|claude-live>
  --local-model <name>        Ollama model (default: deepseek-r1:latest)
  --local-model-selector <cmd>
                              Executable that prints the local model name to stdout
  --local-provider <name>     ollama or openai
  --local-url <url>           Local chat endpoint; accepts Ollama /api/chat or OpenAI /v1
  --turns <n>                 Positive finite turn cap
  --duration-minutes <n>      Wall-clock cap; stops when elapsed
  --delay-ms <n>              Delay between loop turns (default: 5000)
  --review-every <n>          Claude review cadence (default: 4)
  --seed <text>               Seed topic or task
  --transcript <path>         JSONL transcript path
  --token-budget <n>          Approximate total token budget (default: 32000)
  --local-max-tokens <n>      Max generated tokens per local turn (default: 512)
  --local-timeout-ms <n>      Local model request timeout (default: 300000)
  --ollama-url <url>          Ollama chat endpoint
  --claude-model <name>       Claude model label
  --cdp-port <n>              Chrome CDP port
  --no-tools                  Accepted for clarity; tools are always disabled here
  --help                      Show this help text

Examples:
  node collab-cli.mjs --mode local-only --turns 20 --seed "Plan the feature"
  node collab-cli.mjs --mode claude-review --review-every 4 --turns 20
  node collab-cli.mjs --mode claude-live --turns 8
`;
}

async function runModelSelector(selector, options) {
  const command = String(selector || "").trim();
  if (!command) return "";
  const { stdout } = await execFileAsync(command, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WALKIE_COLLAB_MODE: options.mode,
      WALKIE_COLLAB_LOCAL_PROVIDER: options.localProvider || "",
      WALKIE_COLLAB_LOCAL_URL: options.localUrl || "",
      WALKIE_COLLAB_OLLAMA_URL: options.localUrl || "",
    },
    timeout: 15000,
    maxBuffer: 64 * 1024,
  });
  const model = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (!model) throw new Error(`Model selector produced no model: ${command}`);
  return model;
}

function applyLocalSelection(options, selection) {
  const value = String(selection || "").trim();
  if (!value) return;
  const parts = value.split("|").map((part) => part.trim());
  if (parts.length >= 3 && parts[0] && parts[1] && parts.slice(2).join("|")) {
    options.localProvider = parts[0];
    options.localUrl = parts[1];
    options.localModel = parts.slice(2).join("|");
    return;
  }
  options.localModel = value;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    if (arg === "--help" || arg === "--no-tools") {
      flags.add(arg);
      continue;
    }
    if (arg === "--tools") throw new Error("Tools are not available in collab mode.");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value.`);
    values.set(arg, next);
    i++;
  }

  const hasTurns = values.has("--turns");
  const mode = values.get("--mode") || "local-only";
  if (!VALID_MODES.has(mode)) throw new Error(`Invalid --mode: ${mode}`);

  const defaultTurns = mode === "local-only" ? 20 : mode === "claude-review" ? 12 : 8;
  const turns = Number(values.get("--turns") || defaultTurns);
  const durationMinutes = Number(values.get("--duration-minutes") || 0);
  const durationMs = Math.round(durationMinutes * 60_000);
  const delayMs = Number(values.get("--delay-ms") || 5000);
  const reviewEvery = Number(values.get("--review-every") || 4);
  const tokenBudget = Number(values.get("--token-budget") || 32000);
  const localMaxTokens = Number(values.get("--local-max-tokens") || 512);
  const localTimeoutMs = Number(values.get("--local-timeout-ms") || 300000);

  if (!Number.isInteger(turns) || turns <= 0) throw new Error("--turns must be a positive finite integer.");
  if (!Number.isFinite(durationMinutes) || durationMinutes < 0) throw new Error("--duration-minutes must be zero or positive.");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be zero or a positive number.");
  if (!Number.isInteger(reviewEvery) || reviewEvery <= 0) throw new Error("--review-every must be a positive integer.");
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) throw new Error("--token-budget must be a positive number.");
  if (!Number.isInteger(localMaxTokens) || localMaxTokens <= 0) throw new Error("--local-max-tokens must be positive.");
  if (!Number.isFinite(localTimeoutMs) || localTimeoutMs <= 0) throw new Error("--local-timeout-ms must be positive.");
  if (mode === "claude-live" && !hasTurns) throw new Error("claude-live requires an explicit finite --turns value.");
  if (mode === "claude-live" && turns > 20 && durationMs <= 0) {
    throw new Error("claude-live requires --turns 20 or less unless --duration-minutes is set.");
  }
  if (mode === "claude-live" && durationMs > 0 && turns > 2000) {
    throw new Error("claude-live duration mode requires --turns 2000 or less.");
  }
  if ((mode === "claude-live" || mode === "claude-review") && delayMs < 5000) {
    throw new Error("Claude modes require --delay-ms of at least 5000.");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultTranscript = path.join(process.cwd(), ".cache", "collab", `${mode}-${stamp}.jsonl`);

  return {
    help: flags.has("--help"),
    mode,
    localModel: values.get("--local-model") || process.env.WALKIE_COLLAB_LOCAL_MODEL || process.env.WALKIE_LOCAL_MODEL || "",
    localModelExplicit:
      values.has("--local-model") || Boolean(process.env.WALKIE_COLLAB_LOCAL_MODEL || process.env.WALKIE_LOCAL_MODEL),
    localModelSelector: values.get("--local-model-selector") || process.env.WALKIE_COLLAB_MODEL_SELECTOR || "",
    localProvider: values.get("--local-provider") || process.env.WALKIE_COLLAB_LOCAL_PROVIDER || "",
    localUrl:
      values.get("--local-url") ||
      values.get("--ollama-url") ||
      process.env.WALKIE_COLLAB_LOCAL_URL ||
      process.env.OLLAMA_CHAT_URL ||
      "",
    turns,
    durationMs,
    durationMinutes,
    delayMs,
    reviewEvery,
    tokenBudget,
    localMaxTokens,
    localTimeoutMs,
    seed: values.get("--seed") || "Discuss the requested topic and converge on concise next steps.",
    transcriptPath: values.get("--transcript") || defaultTranscript,
    ollamaUrl: values.get("--ollama-url") || process.env.OLLAMA_CHAT_URL,
    claudeModel: values.get("--claude-model") || process.env.CLAUDE_SONNET_MODEL || "Sonnet 4.6 Max",
    cdpPort: Number(values.get("--cdp-port") || process.env.CLAUDE_CDP_PORT || "9222"),
    chromeBin: values.get("--chrome-bin") || process.env.CLAUDE_CHROME_BIN || "",
  };
}

function writeTurn(entry) {
  const color = entry.role?.startsWith("claude") ? C.cyan : entry.role === "local_peer" ? C.yellow : C.green;
  process.stdout.write(`\n${C.bold}${color}${entry.role}>${C.reset} ${C.dim}turn ${entry.turn}${C.reset}\n`);
  process.stdout.write(`${String(entry.content || "").trim()}\n`);
}

function writeEvent(event) {
  if (event.type === "start") {
    process.stdout.write(`${C.dim}[collab] mode=${event.mode} transcript=${event.transcript}${C.reset}\n`);
  } else if (event.type === "asking") {
    process.stdout.write(`${C.dim}[asking ${event.role} turn ${event.turn}]${C.reset}\n`);
  } else if (event.type === "stop") {
    if (event.reason === "tool_request_detected") {
      process.stdout.write(`\n${C.red}tool request detected; collab loop paused${C.reset}\n`);
      process.stdout.write(`speaker: ${event.speaker || "unknown"}\n`);
      process.stdout.write(`requested: ${event.detail || "unknown"}\n`);
      process.stdout.write("approve manually in normal CLI mode if needed\n");
    } else {
      process.stdout.write(`\n${C.dim}[stopped] ${event.reason}${event.detail ? ` ${event.detail}` : ""}${C.reset}\n`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const transcript = new TranscriptStore(options.transcriptPath, {
    mode: options.mode,
    localModel: options.localModel || "auto",
    claudeModel: options.mode === "local-only" ? null : options.claudeModel,
    tools: "disabled",
    durationMinutes: options.durationMinutes,
    delayMs: options.delayMs,
    host: os.hostname(),
  });

  if (!options.localModel && options.localModelSelector) {
    applyLocalSelection(options, await runModelSelector(options.localModelSelector, options));
    options.localModelExplicit = true;
    process.stderr.write(`${C.dim}[local] selector picked ${options.localModel}${C.reset}\n`);
  } else if (options.localModel) {
    applyLocalSelection(options, options.localModel);
  }

  const resolvedLocalModel = options.localModelExplicit
    ? options.localModel
    : await LocalModelClient.resolveModel("", {
        endpoint: options.localUrl || options.ollamaUrl || undefined,
        provider: options.localProvider || undefined,
      });
  if (!options.localModelExplicit) {
    process.stderr.write(`${C.dim}[local] selected ${resolvedLocalModel}${C.reset}\n`);
  }
  transcript.metadata.localModel = resolvedLocalModel;

  const localClient = new LocalModelClient({
    model: resolvedLocalModel,
    endpoint: options.localUrl || options.ollamaUrl || undefined,
    provider: options.localProvider || undefined,
    maxTokens: options.localMaxTokens,
    requestTimeoutMs: options.localTimeoutMs,
  });

  let claudeClient = null;
  if (options.mode !== "local-only") {
    const noToolPrompt = [
      "WALKIE_COLLAB_NO_TOOLS",
      "You are in bounded collab mode.",
      "Local tool execution is disabled for this mode.",
      "Do not emit tool calls. Do not ask the wrapper to run shell, file, or process tools.",
    ].join("\n");
    claudeClient = new ClaudeFreeSession({
      cdpPort: options.cdpPort,
      targetModel: options.claudeModel,
      chromeBin: options.chromeBin,
      enableTools: false,
      toolPrompt: noToolPrompt,
    });
    claudeClient.on("state-change", ({ state, detail }) => {
      process.stderr.write(`${C.dim}[claude ${state}] ${detail || ""}${C.reset}\n`);
    });
    process.stderr.write(`${C.dim}[claude] connecting; complete browser login if prompted${C.reset}\n`);
    await claudeClient.connect();
    await claudeClient.newChat().catch(() => {});
  }

  const safety = new SafetyGovernor({
    maxTurns: options.turns,
    tokenBudget: options.tokenBudget,
  });
  const orchestrator = new CollabOrchestrator({
    mode: options.mode,
    turns: options.turns,
    delayMs: options.delayMs,
    durationMs: options.durationMs,
    reviewEvery: options.reviewEvery,
    seed: options.seed,
    localClient,
    claudeClient,
    transcriptStore: transcript,
    safetyGovernor: safety,
    onEvent: writeEvent,
    onTurn: writeTurn,
  });

  try {
    const result = await orchestrator.run();
    process.stdout.write(`${C.dim}transcript: ${result.transcriptPath}${C.reset}\n`);
  } finally {
    await claudeClient?.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${C.red}[error]${C.reset} ${error.message}\n`);
  process.exitCode = 1;
});
