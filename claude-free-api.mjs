#!/usr/bin/env node
// claude-free-api.mjs — Clean, importable API for the claude.ai free tier.
// Extracted from chat-app.mjs / walkie.mjs with enhanced tool calling.
import { EventEmitter } from "node:events";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import {
  chmod as chmodPath,
  glob as fsGlob,
  mkdir as makeDir,
  readdir,
  readFile,
  realpath,
  stat as statPath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
  host: "127.0.0.1",
  cdpPort: 9222,
  chatUrl: "https://claude.ai/new",
  targetModel: "Sonnet 4.6 Max",
  timeoutMs: 120000,
  toolLoopLimit: 8,
  profileDir: path.join(os.homedir(), ".cache", "claude-walkie-cdp"),
  logPath: path.join(os.homedir(), ".cache", "claude-website-chat.log"),
  logMaxBytes: 2 * 1024 * 1024,
};

// ── helpers ──────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function truncateText(text, maxChars = 200000) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function resolveLocalPath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") throw new Error("Tool path is required.");
  const expanded =
    inputPath === "~"
      ? os.homedir()
      : inputPath.startsWith("~/")
        ? path.join(os.homedir(), inputPath.slice(2))
        : inputPath;
  return path.resolve(expanded);
}

function makeNonce() {
  return `walkie${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function isProtocolFailure(text) {
  if (!text) return false;
  return [
    /\/home\/claude\b/i,
    /\/home\/ubuntu\b/i,
    /\/mnt\/user-data\b/i,
    /\bupload (the )?(file|files|it)\b/i,
    /\bi (do not|don't|cannot|can't) (have )?(direct )?(access|see) (to )?(your|the user's) (pc|computer|filesystem|files)/i,
  ].some((pattern) => pattern.test(text));
}

// ── selectors (mirrors chat-app.mjs for robustness) ──────────────────────────
const INPUT_CANDIDATES = [
  '[data-testid="chat-input"]',
  '[data-testid="message-input"]',
  '[data-testid="conversation-input"]',
  '[aria-label*="Message"]',
  '[placeholder*="Message"]',
  '[placeholder*="message"]',
  '[role="textbox"][contenteditable="true"]',
  'textarea[placeholder]',
  'div[contenteditable="true"]',
  'div[contenteditable="plaintext-only"]',
];

const STOP_BUTTON_CANDIDATES = [
  'button:has-text("Stop generating")',
  'button:has-text("Stop")',
  'button[aria-label*="Stop"]',
];

const MODEL_BUTTON_CANDIDATES = [
  '[data-testid="model-selector"]',
  'button:has-text("Model")',
  'button[aria-label*="Model"]',
  '[data-testid*="model"] button',
];

// ── tool instructions ────────────────────────────────────────────────────────
const TOOL_PREFIX = [
  "WALKIE_PROTOCOL_V1",
  "Act like an API-backed local CLI agent. The local wrapper provides the tools; you provide decisions and final answers.",
  "You do not directly see the user's PC. Never inspect or describe your own sandbox/container as if it were the user's machine.",
  "For any local file, repo, process, branch, command, model, or path question, request exactly one local tool call and no other text.",
  "Do not mention /home/claude, /home/ubuntu, /mnt/user-data, uploads, or sandbox paths as if they were the user's PC.",
  "Tool call rules:",
  "- Use exactly one complete tool call when a tool is needed.",
  "- Use only the canonical tool names listed below; do not use aliases like listdir/readfile/timeoutms.",
  "- The tool call body must be valid JSON with a top-level name and arguments object.",
  "- Escape quotes inside shell commands. Do not emit a partial tool call, duplicate tool call, or corrected second copy.",
  "- Include the exact nonce provided for this turn.",
  "Tool call format:",
  '<tool_call nonce="NONCE">{"name":"TOOL_NAME","arguments":{...}}</tool_call>',
  "Available tools:",
  '- list_dir: {"path":"/path"}',
  '- read_file: {"path":"/path","max_bytes":200000}',
  '- write_file: {"path":"/path","content":"text"}',
  '- edit_file: {"path":"/path","old_string":"exact","new_string":"replacement"} (old_string must be unique)',
  '- mkdir: {"path":"/path"}',
  '- stat: {"path":"/path"}',
  '- chmod: {"path":"/path","mode":"755"}',
  '- shell: {"command":"pwd && ls","cwd":"/home/tim","timeout_ms":30000}',
  '- start_shell: {"command":"...","cwd":"/home/tim","log_path":"/tmp/job.log"} (long-running background jobs)',
  '- check_process: {"pid":N,"log_path":"/tmp/job.log","tail_bytes":20000}',
  '- grep: {"pattern":"regex","path":"/dir/or/file","max_results":200}',
  '- glob: {"pattern":"**/*.js","path":"/home/tim/project"}',
  "Use absolute paths. Default working directory is /home/tim. Known important repo path: /home/tim/llama.cpp.",
  "After a tool result, answer normally or request another single canonical tool call.",
].join("\n");

// ── log helper ───────────────────────────────────────────────────────────────
function makeLogger(logPath, logMaxBytes) {
  // rotate
  try {
    if (existsSync(logPath)) {
      const st = statSync(logPath);
      if (st.size > logMaxBytes) {
        const data = readFileSync(logPath, "utf8");
        writeFileSync(logPath, data.slice(Math.floor(data.length * 0.6)), "utf8");
      }
    }
  } catch { /* best effort */ }

  return (level, message, detail) => {
    const ts = new Date().toISOString();
    const extra = detail ? " " + JSON.stringify(detail) : "";
    const line = `${ts} [${level}] ${message}${extra}\n`;
    try { appendFileSync(logPath, line, "utf8"); } catch {}
    if (level === "error") console.error(line.trim());
  };
}

// ── shell helpers ────────────────────────────────────────────────────────────
function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timed_out: timedOut, stdout: truncateText(stdout, 120000), stderr: truncateText(stderr, 120000) });
    });
  });
}

function startShellJob(command, cwd, logPath, timeoutMs = 3_600_000) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  const child = spawn("bash", ["-lc", command], {
    cwd,
    env: process.env,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, 3000).unref();
  }, timeoutMs);
  timer.unref();
  child.on("close", () => clearTimeout(timer));
  child.unref();
  return { pid: child.pid, command, cwd, log_path: logPath, timeout_ms: timeoutMs };
}

// ── tool-call parsing ────────────────────────────────────────────────────────
// Old XML format (still supported for backward compat):
function tryParseJson(text) { try { return JSON.parse(text); } catch { return null; } }
function normalizeNonce(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sameNonce(actual, expected) {
  if (!expected) return true;
  return normalizeNonce(actual) === normalizeNonce(expected);
}

function normalizeToolName(name) {
  const compact = String(name || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    listdir: "list_dir",
    list_directory: "list_dir",
    readfile: "read_file",
    writefile: "write_file",
    editfile: "edit_file",
    startshell: "start_shell",
    start_job: "start_shell",
    checkprocess: "check_process",
    process_status: "check_process",
  };
  return aliases[compact] || compact;
}

function normalizeToolArgs(args) {
  const normalized = { ...(args || {}) };
  const aliases = {
    maxbytes: "max_bytes",
    max_bytes: "max_bytes",
    timeoutms: "timeout_ms",
    timeout_ms: "timeout_ms",
    logpath: "log_path",
    log_path: "log_path",
    tailbytes: "tail_bytes",
    tail_bytes: "tail_bytes",
    oldstring: "old_string",
    old_string: "old_string",
    newstring: "new_string",
    new_string: "new_string",
  };

  for (const [key, value] of Object.entries(args || {})) {
    const compact = key.toLowerCase().replace(/[\s-]+/g, "_");
    const alias = aliases[compact] || aliases[compact.replace(/_/g, "")];
    if (alias && alias !== key && normalized[alias] === undefined) {
      normalized[alias] = value;
      delete normalized[key];
    }
  }
  return normalized;
}

function extractNonceFromAttrs(attrs) {
  const match = String(attrs || "").match(/\bnonce\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  return String(match?.[1] || match?.[2] || match?.[3] || "").trim();
}

function findJsonObject(text, startIndex) {
  const start = text.indexOf("{", startIndex);
  if (start === -1) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function findToolCallInner(text, startIndex) {
  const rest = text.slice(startIndex);
  const close = rest.search(/<\/tool_?call>/i);
  const next = rest.search(/<tool_?call\b/i);
  let end = rest.length;
  if (close !== -1) end = Math.min(end, close);
  if (next !== -1) end = Math.min(end, next);
  return rest.slice(0, end).trim();
}

function looseStringField(text, key) {
  const startRe = new RegExp(`"${key}"\\s*:\\s*"`, "i");
  const startMatch = startRe.exec(text);
  if (!startMatch) return "";
  const start = startMatch.index + startMatch[0].length;
  const after = text.slice(start);
  const nextKey = after.search(/"\s*,\s*"[a-zA-Z_][a-zA-Z0-9_]*"\s*:/);
  const raw = nextKey === -1 ? after : after.slice(0, nextKey);
  return raw.replace(/"\s*$/, "").trim();
}

function looseNumberField(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`, "i").exec(text);
  return match ? Number(match[1]) : undefined;
}

function parseLooseToolCall(inner, tagNonce) {
  const name = looseStringField(inner, "name") || looseStringField(inner, "tool");
  if (!name) return null;
  const args = {};
  for (const key of ["path", "cwd", "command", "max_bytes", "maxbytes", "timeout_ms", "timeoutms", "log_path", "logpath", "tail_bytes", "tailbytes", "pattern"]) {
    const value = looseStringField(inner, key);
    if (value) args[key] = value;
  }
  for (const key of ["timeout_ms", "timeoutms", "max_bytes", "maxbytes", "tail_bytes", "tailbytes"]) {
    const value = looseNumberField(inner, key);
    if (value !== undefined && args[key] === undefined) args[key] = value;
  }
  for (const key of ["timeout_ms", "timeoutms", "max_bytes", "maxbytes", "tail_bytes", "tailbytes"]) {
    if (args[key] !== undefined && /^-?\d+$/.test(String(args[key]))) args[key] = Number(args[key]);
  }
  if (Object.keys(args).length === 0) return null;
  return normalizeToolCall({ name, arguments: args, nonce: tagNonce });
}

function normalizeToolCall(raw) {
  const call = raw.tool_call || raw;
  const rawName = String(call.name || call.tool || "").trim();
  const name = normalizeToolName(rawName);
  const args = normalizeToolArgs(call.arguments && typeof call.arguments === "object" ? call.arguments : { ...call });
  const nonce = String(call.nonce || raw.nonce || args.nonce || "").trim();
  delete args.name; delete args.tool; delete args.arguments; delete args.nonce;
  if (!name) throw new Error("Tool call is missing a name.");
  return { name, arguments: args, nonce, rawName };
}

function extractToolCall(text, expectedNonce = "") {
  if (!text) return null;

  const tagRe = /<tool_?call\b([^>]*)>/gi;
  const candidates = [];
  let match;
  while ((match = tagRe.exec(text)) !== null) {
    const tagNonce = extractNonceFromAttrs(match[1]);
    if (!sameNonce(tagNonce, expectedNonce)) continue;
    const inner = findToolCallInner(text, tagRe.lastIndex);
    const jsonText = findJsonObject(text, tagRe.lastIndex);
    const parsedJson = tryParseJson(jsonText);
    const parsed = parsedJson || parseLooseToolCall(inner, tagNonce);
    if (!parsed) continue;
    try {
      const normalized = normalizeToolCall(parsed);
      if (!normalized.nonce && tagNonce) normalized.nonce = tagNonce;
      if (!sameNonce(normalized.nonce || tagNonce, expectedNonce)) continue;
      normalized.parseQuality = parsedJson ? 2 : 1;
      normalized.hasClosingTag = /<\/tool_?call>/i.test(text.slice(tagRe.lastIndex, tagRe.lastIndex + inner.length + 32));
      if (normalized.name) candidates.push(normalized);
    } catch { continue; }
  }
  if (!candidates.length) return null;

  const score = (call, index) => {
    const raw = String(call.rawName || "").trim();
    let value = index;
    value += Number(call.parseQuality || 0) * 10000;
    if (call.hasClosingTag) value += 1000;
    if (raw === call.name) value += 1000;
    if (raw.includes("_")) value += 250;
    if (call.arguments?.path && /_[a-z0-9]/i.test(call.arguments.path)) value += 100;
    return value;
  };

  return candidates
    .map((call, index) => ({ call, score: score(call, index) }))
    .sort((a, b) => b.score - a.score)[0].call;
}

// ── log helper ───────────────────────────────────────────────────────────────
// ── ClaudeFreeSession ────────────────────────────────────────────────────────
export class ClaudeFreeSession extends EventEmitter {
  #opts;
  #log;
  #browser = null;
  #context = null;
  #page = null;
  #busy = false;

  constructor(options = {}) {
    super();
    this.#opts = {
      host: options.host || DEFAULTS.host,
      cdpPort: Number(options.cdpPort || process.env.CLAUDE_CDP_PORT || DEFAULTS.cdpPort),
      chatUrl: options.chatUrl || process.env.CLAUDE_CHAT_URL || DEFAULTS.chatUrl,
      targetModel: options.targetModel || process.env.CLAUDE_SONNET_MODEL || DEFAULTS.targetModel,
      timeoutMs: Number(options.timeoutMs || process.env.CLAUDE_RESPONSE_TIMEOUT || DEFAULTS.timeoutMs),
      toolLoopLimit: options.toolLoopLimit ?? DEFAULTS.toolLoopLimit,
      profileDir: options.profileDir || process.env.CLAUDE_CDP_PROFILE || DEFAULTS.profileDir,
      chromeBin: options.chromeBin || process.env.CLAUDE_CHROME_BIN || "",
      headless: options.headless || false,
      // Security
      allowedPaths: options.allowedPaths || [os.homedir(), "/tmp", "/var/tmp"],
      requireConfirmation: options.requireConfirmation !== false, // default true
      enableTools: options.enableTools !== false,
      onConfirm: options.onConfirm || null, // async (call, risk) => boolean
      auditLog: options.auditLog || path.join(os.homedir(), ".cache", "claude-free-audit.log"),
      // Allow overriding the tool prompt (for CLI vs TUI)
      toolPrompt: options.toolPrompt || null,
    };
    this.#opts.cdpUrl = `http://${this.#opts.host}:${this.#opts.cdpPort}`;
    this.#log = makeLogger(DEFAULTS.logPath, DEFAULTS.logMaxBytes);
    this.#log("info", "ClaudeFreeSession created", {
      cdpPort: this.#opts.cdpPort,
      confirmation: this.#opts.requireConfirmation,
      allowedPaths: this.#opts.allowedPaths,
    });
  }

  // -- public API -------------------------------------------------------------
  get state() { return this._state; }
  get busy() { return this.#busy; }
  get model() { return this.#opts.targetModel; }

  // Allow the TUI to install a confirmation callback after construction.
  // fn: async (call, risk) => boolean
  setConfirmCallback(fn) {
    this.#opts.onConfirm = fn;
  }

  async connect() {
    if (this._state === "ready") return;
    this._setState("connecting", "Locating Chrome browser.");
    const chromeBin = await this.#resolveChrome();
    if (!chromeBin) throw new Error("Chrome or Chromium was not found.");
    this.#log("info", "chrome resolved", { chromeBin });

    if (!(await this.#probeCdp())) {
      this._setState("connecting", "Starting Chrome with Claude.ai. Log in if needed.");
      this.#log("info", "no CDP endpoint, launching Chrome");
      await this.#startChrome(chromeBin);
    }

    this._setState("connecting", "Waiting for Chrome debug interface.");
    for (let i = 0; i < 120; i++) {
      if (await this.#probeCdp()) break;
      if (i === 20) this._setState("connecting", "Still waiting. Complete any login prompts.");
      await delay(500);
    }
    if (!(await this.#probeCdp())) throw new Error(`Chrome CDP not reachable at ${this.#opts.cdpUrl}.`);

    this.#log("info", "CDP ready, connecting Playwright");
    this.#browser = await chromium.connectOverCDP(this.#opts.cdpUrl);
    this.#context = this.#browser.contexts()[0] || (await this.#browser.newContext());
    await this.#context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = window.chrome || {};
    });
    this.#page =
      this.#context.pages().find((p) => p.url().includes("claude.ai")) ||
      (await this.#context.newPage());
    // Set short timeout for all page operations — prevents hangs on stale CDP
    this.#page.setDefaultTimeout(15000);
    await this.#page.goto(this.#opts.chatUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await this.#page.bringToFront().catch(() => {});

    this._setState("connecting", "Looking for chat input. Complete any login or verification.");
    await this.#waitForComposer();
    const modelOk = await this.#clickModelIfNeeded(this.#opts.targetModel);
    this.#log("info", "connect complete", { modelSelected: modelOk });
    this._setState(
      "ready",
      `Connected. ${modelOk ? `Model: ${this.#opts.targetModel}.` : ""} Local tools ${this.#opts.enableTools ? "enabled" : "disabled"}.`,
    );
  }

  async send(text) {
    if (this._state !== "ready") throw new Error("Claude.ai is not ready. Call connect() first.");
    if (this.#busy) throw new Error("A message is already running.");
    this.#busy = true;
    this._setState("busy", "Claude is responding...");
    this.#log("info", "user message", { text: text.slice(0, 200) });
    // User message is rendered locally by the TUI — don't emit "user"
    try {
      const result = await this.#runWithTools(text);
      this.emit("done", { text: result });
      this._setState("ready", `Connected. Local tools ${this.#opts.enableTools ? "enabled" : "disabled"}.`);
      return result;
    } catch (error) {
      this.#log("error", "send failed", { message: error.message });
      this.emit("error", { message: error.message });
      this._setState("ready", `Connected. Last request failed.`);
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async runLocalTool(nameOrCall, args = {}) {
    const call = typeof nameOrCall === "string"
      ? { name: String(nameOrCall).trim(), arguments: args && typeof args === "object" ? args : {} }
      : normalizeToolCall(nameOrCall);
    if (!call.name) throw new Error("Tool name is required.");

    this.#log("info", "direct local tool call", { name: call.name });
    this.emit("tool-call", { name: call.name, arguments: call.arguments, round: 0 });

    const safe = await this.#checkIntrusion(call);
    if (!safe) throw new Error("Tool call was blocked by intrusion detection.");

    const risk = this.#assessRisk(call.name, call.arguments || {});
    const approved = await this.#confirmTool(call, risk);

    let result;
    if (!approved) {
      result = {
        ok: false,
        error: risk.blocked
          ? `Blocked by security policy: ${risk.reasons.join(", ")}`
          : "Operation requires user confirmation. Denied.",
      };
      this.#log("warn", "direct local tool denied", { name: call.name, reasons: risk.reasons });
    } else {
      try {
        result = { ok: true, result: await this.#executeTool(call) };
        this.#log("info", "direct local tool result ok", { name: call.name });
      } catch (error) {
        result = { ok: false, error: error.message };
        this.#log("error", "direct local tool result failed", { name: call.name, error: error.message });
      }
    }

    this.#audit({
      tool: call.name,
      args: truncateText(JSON.stringify(call.arguments || {}), 2000),
      ok: result.ok,
      risk: risk.reasons,
      approved,
      direct: true,
    });

    this.emit("tool-result", { name: call.name, ok: result.ok, output: result });
    return result;
  }

  async newChat() {
    try {
      await this.#page.goto("https://claude.ai/new", { waitUntil: "domcontentloaded", timeout: 15000 });
      await new Promise((r) => setTimeout(r, 1000));
    } catch { /* best effort */ }
  }

  async close() {
    this.#log("info", "closing session");
    // This wrapper attaches to the user's real Chrome over CDP. Do not close
    // the page, context, or browser here; doing so can destroy the signed-in
    // claude.ai session and force another security check. Let process exit
    // tear down only the Playwright client connection.
    this.#browser = null;
    this.#context = null;
    this.#page = null;
    this._setState("disconnected", "Session closed.");
  }

  // -- internal: state management ---------------------------------------------
  _setState(state, detail) {
    this._state = state;
    this.emit("state-change", { state, detail });
    this.#log("info", "state-change", { state, detail });
  }

  // -- security layer ──────────────────────────────────────────────────────────
  #audit(entry) {
    const ts = new Date().toISOString();
    const line = `${ts} ${JSON.stringify(entry)}\n`;
    try { appendFileSync(this.#opts.auditLog, line, "utf8"); } catch {}
  }

  #isPathAllowed(target) {
    const resolved = this.#realPathForPolicySync(target);
    return this.#opts.allowedPaths.some((prefix) => {
      const allowed = this.#realPathForPolicySync(prefix);
      return resolved === allowed || resolved.startsWith(allowed + path.sep);
    });
  }

  #realPathForPolicySync(target) {
    const resolved = path.resolve(target);
    try {
      return realpathSync(resolved);
    } catch {
      let current = resolved;
      const missing = [];
      while (current && current !== path.dirname(current)) {
        try {
          const realParent = realpathSync(current);
          return path.join(realParent, ...missing.reverse());
        } catch {
          missing.push(path.basename(current));
          current = path.dirname(current);
        }
      }
      return resolved;
    }
  }

  async #realPathForPolicy(target) {
    const resolved = path.resolve(target);
    try {
      return await realpath(resolved);
    } catch {
      let current = resolved;
      const missing = [];
      while (current && current !== path.dirname(current)) {
        try {
          const realParent = await realpath(current);
          return path.join(realParent, ...missing.reverse());
        } catch {
          missing.push(path.basename(current));
          current = path.dirname(current);
        }
      }
      return resolved;
    }
  }

  async #assertPathAllowed(target, label = "path") {
    const policyPath = await this.#realPathForPolicy(target);
    const allowedRoots = await Promise.all(this.#opts.allowedPaths.map((prefix) => this.#realPathForPolicy(prefix)));
    const ok = allowedRoots.some((allowed) => policyPath === allowed || policyPath.startsWith(allowed + path.sep));
    if (!ok) throw new Error(`${label} outside allowed directories after symlink resolution: ${target} -> ${policyPath}`);
    return path.resolve(target);
  }

  // Commands that are always blocked (fork bombs, device writes, etc.)
  #BLOCKED_PATTERNS = [
    /\brm\s+-rf\s+\//,                                  // rm -rf /
    />\s*\/dev\/(sd|nvme|hd|xvd|vd|mmcblk)/,           // overwrite block device
    /\bmkfs\./,                                          // make filesystem
    /\bdd\s+if=.*\s+of=\/dev\//,                        // dd to block device
    /:\(\)\s*\{/,                                        // fork bomb
    /\bchmod\s+(-R\s+)?777\s+\//,                       // chmod 777 /
    /\bwget\s+.*\|\s*(ba)?sh/,                          // curl/wget pipe to shell
    /\bcurl\s+.*\|\s*(ba)?sh/,
    /(^|[;&|]\s*)(nohup|setsid)\b/,                      // process escape
    /\bdisown\b/,                                        // process escape
    /&\s*($|[;])/,                                       // background escape
  ];

  // Commands that require user confirmation
  #DANGEROUS_PATTERNS = [
    /\brm\s+-r/,                                         // recursive remove
    /\brm\s+-rf/,                                        // force recursive remove
    /\b(>|>>)\s/,                                        // output redirection (overwrite)
    /\bchmod\s/,                                         // permission changes
    /\bchown\s/,                                         // ownership changes
    /\bkill\s+-9/,                                       // force kill
    /\bshutdown\b/,                                      // shutdown/reboot
    /\breboot\b/,
    /\bsystemctl\s+(stop|disable|mask)/,                // systemd service control
    /\bgit\s+push\s+--force/,                           // force push
    /\bdocker\s+(rm|rmi|system\s+prune)/,               // docker cleanup
    /\bgit\s+reset\s+--hard/,                           // hard git reset
  ];

  #assessRisk(name, args) {
    const risks = [];
    const outcome = { blocked: false, confirm: false, reasons: [] };

    // Path checks for file operations
    const pathArg = args.path || args.target || args.log_path;
    if (pathArg) {
      try {
        if (!this.#isPathAllowed(resolveLocalPath(pathArg))) {
          risks.push(`path outside allowed directories: ${pathArg}`);
          outcome.confirm = true;
          outcome.reasons.push("path-outside-allowed");
        }
      } catch { /* path resolution failure — let the tool execution handle it */ }
    }

    // Command checks for shell operations
    const cmd = args.command;
    if (cmd && (name === "shell" || name === "start_shell")) {
      // Block list — always reject
      for (const pattern of this.#BLOCKED_PATTERNS) {
        if (pattern.test(cmd)) {
          outcome.blocked = true;
          outcome.reasons.push(`blocked-pattern: ${pattern.source.slice(0, 40)}`);
          break;
        }
      }

      // Dangerous list — confirm
      if (!outcome.blocked) {
        for (const pattern of this.#DANGEROUS_PATTERNS) {
          if (pattern.test(cmd)) {
            outcome.confirm = true;
            outcome.reasons.push(`dangerous-pattern: ${pattern.source.slice(0, 40)}`);
            break;
          }
        }
      }
    }

    // chmod always confirm
    if (name === "chmod") {
      outcome.confirm = true;
      outcome.reasons.push("permission-change");
    }

    // write_file — confirm if writing outside home
    if (name === "write_file" && pathArg) {
      try {
        if (!this.#isPathAllowed(resolveLocalPath(pathArg))) {
          outcome.confirm = true;
          outcome.reasons.push("write-outside-allowed");
        }
      } catch {}
    }

    // edit_file — same as write
    if (name === "edit_file" && pathArg) {
      try {
        if (!this.#isPathAllowed(resolveLocalPath(pathArg))) {
          outcome.confirm = true;
          outcome.reasons.push("edit-outside-allowed");
        }
      } catch {}
    }

    return outcome;
  }

  async #confirmTool(call, risk) {
    if (!this.#opts.requireConfirmation) return true;
    if (!risk.confirm && !risk.blocked) return true;

    if (risk.blocked) {
      this.#log("warn", "tool blocked by security policy", { name: call.name, reasons: risk.reasons });
      return false; // blocked — never allowed
    }

    // If no callback, default-deny dangerous operations
    if (!this.#opts.onConfirm) {
      this.#log("warn", "tool requires confirmation but no callback registered — denying", {
        name: call.name,
        reasons: risk.reasons,
      });
      return false;
    }

    try {
      const approved = await this.#opts.onConfirm(call, risk);
      this.#log("info", approved ? "tool confirmed by user" : "tool denied by user", {
        name: call.name,
        reasons: risk.reasons,
      });
      return approved;
    } catch {
      return false;
    }
  }

  // Prompt injection guard — strip tool-call/tool-result tags from user input
  #sanitizeInput(text) {
    if (!text) return text;
    // Strip any tool protocol tags from user input.
    let cleaned = text.replace(/<tool_?call\b[\s\S]*?<\/tool_?call>/gi, "[tool_call blocked]");
    cleaned = cleaned.replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, "[tool_result blocked]");
    return cleaned;
  }

  // -- intrusion detection ────────────────────────────────────────────────────
  #intrusionScore = 0;
  #intrusionEvents = [];
  #INTRUSION_THRESHOLD = 150;
  #INTRUSION_DECAY_MS = 60_000; // score halves every 60s
  #lastIntrusionCheck = Date.now();

  #SENSITIVE_PATHS = [
    "/etc/shadow", "/etc/passwd", "/etc/sudoers", "/etc/ssl", "/etc/ssh",
    "/root/", "/var/log/auth", "/proc/", "/sys/",
  ];

  #SENSITIVE_GLOBS = [
    "**/.ssh/**", "**/.gnupg/**", "**/.aws/**", "**/.config/**",
    "**/.gitconfig", "**/.bash_history", "**/.env", "**/.netrc",
    "**/credentials", "**/*.pem", "**/*-key", "**/id_rsa*",
  ];

  #CREDENTIAL_PATTERNS = [
    /password\s*[=:]\s*\S+/i, /secret\s*[=:]\s*\S+/i,
    /api[_-]?key\s*[=:]\s*\S+/i, /token\s*[=:]\s*\S+/i,
    /private[_-]?key/i, /access[_-]?key/i,
    /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----/,
  ];

  #EXFIL_PATTERNS = [
    /\bcurl\s+.*https?:\/\//, /\bwget\s+.*https?:\/\//,
    /\bnc\s+-[lpe]/i, /\bncat\s+-[lpe]/i,
    /\bbase64\b/, /\bxxd\b/,
    /\bscp\b/, /\brsync\b/, /\bsftp\b/,
  ];

  #PERSISTENCE_PATHS = [
    /\.bashrc/, /\.profile/, /\.zshrc/, /\.bash_profile/,
    /crontab/, /\/cron\.d\//, /\/systemd\/system\//,
    /\.config\/autostart/, /\/\.local\/share\/applications\//,
    /\/\.ssh\/authorized_keys/,
  ];

  #decayIntrusionScore() {
    const now = Date.now();
    const elapsed = now - this.#lastIntrusionCheck;
    if (elapsed > this.#INTRUSION_DECAY_MS) {
      const halvings = Math.floor(elapsed / this.#INTRUSION_DECAY_MS);
      this.#intrusionScore = Math.floor(this.#intrusionScore / Math.pow(2, halvings));
    }
    this.#lastIntrusionCheck = now;
  }

  #scoreIntrusion(name, args) {
    let score = 0;
    const reasons = [];
    const pathArg = args.path || args.target || "";
    const cmd = args.command || "";
    const content = args.content || args.old_string || args.new_string || "";
    const pattern = args.pattern || "";

    // Sensitive path access (read or write)
    if (pathArg) {
      try {
        const resolved = resolveLocalPath(pathArg);
        for (const sp of this.#SENSITIVE_PATHS) {
          if (resolved === sp || resolved.startsWith(sp)) {
            score += 40;
            reasons.push(`sensitive-path:${sp}`);
            break;
          }
        }
        // Check sensitive globs (simplified — check path segments)
        for (const sg of this.#SENSITIVE_GLOBS) {
          const key = sg.replace(/\*\*\//g, "").replace(/\*\*/g, "").replace(/\*/g, "");
          if (resolved.includes(key)) {
            score += 30;
            reasons.push(`sensitive-glob:${sg}`);
            break;
          }
        }
      } catch {}
    }

    // Credential scraping via grep or read_file
    if ((name === "grep" || name === "read_file") && (pattern || content)) {
      const searchText = pattern || content;
      for (const cp of this.#CREDENTIAL_PATTERNS) {
        if (cp.test(searchText) || cp.test(pathArg)) {
          score += 35;
          reasons.push(`credential-pattern:${cp.source.slice(0, 30)}`);
          break;
        }
      }
    }

    // Exfiltration via shell
    if (name === "shell" || name === "start_shell") {
      for (const ep of this.#EXFIL_PATTERNS) {
        if (ep.test(cmd)) {
          score += 70;
          reasons.push(`exfil-pattern:${ep.source.slice(0, 30)}`);
          break;
        }
      }
      // sudo / su
      if (/\bsudo\b/.test(cmd) || /\bsu\s/.test(cmd)) {
        score += 90;
        reasons.push("privilege-escalation");
      }
    }

    // Persistence mechanism
    if ((name === "write_file" || name === "edit_file") && pathArg) {
      for (const pp of this.#PERSISTENCE_PATHS) {
        if (pp.test(pathArg)) {
          score += 80;
          reasons.push(`persistence-path:${pp.source.slice(0, 40)}`);
          break;
        }
      }
    }

    // chmod 777
    if (name === "chmod" && /^0?777$/.test(String(args.mode || ""))) {
      score += 50;
      reasons.push("world-writable-permission");
    }

    // Rapid-fire tool calls
    const recentCalls = this.#intrusionEvents.filter(
      (e) => Date.now() - e.ts < 10_000
    ).length;
    if (recentCalls > 5) {
      score += (recentCalls - 5) * 20;
      reasons.push(`rapid-calls:${recentCalls}`);
    }

    return { score, reasons };
  }

  async #checkIntrusion(call) {
    const name = call.name;
    const args = call.arguments || {};

    // If a blocked pattern was matched (from security layer), immediate quarantine
    const risk = this.#assessRisk(name, args);
    if (risk.blocked) {
      await this.#quarantine("blocked-pattern-matched", call, risk.reasons);
      return false; // unreachable — quarantine exits
    }

    this.#decayIntrusionScore();
    const { score, reasons } = this.#scoreIntrusion(name, args);

    this.#intrusionScore += score;
    this.#intrusionEvents.push({
      ts: Date.now(),
      name,
      args: truncateText(JSON.stringify(args), 500),
      score,
      reasons,
    });
    // Keep last 50 events
    if (this.#intrusionEvents.length > 50) {
      this.#intrusionEvents = this.#intrusionEvents.slice(-50);
    }

    if (score > 0) {
      this.#log("warn", "intrusion score delta", {
        name,
        score,
        cumulative: this.#intrusionScore,
        reasons,
      });
    }

    if (this.#intrusionScore >= this.#INTRUSION_THRESHOLD) {
      await this.#quarantine("cumulative-threshold-breach", call, reasons);
      return false;
    }

    return true;
  }

  async #quarantine(reason, call, extraReasons) {
    const incident = {
      ts: new Date().toISOString(),
      reason,
      tool: call.name,
      args: truncateText(JSON.stringify(call.arguments || {}), 2000),
      cumulativeScore: this.#intrusionScore,
      extraReasons,
      recentEvents: this.#intrusionEvents.slice(-20),
    };

    // Write quarantine log
    const qLog = path.join(os.homedir(), ".cache", "claude-free-quarantine.log");
    const entry = `${JSON.stringify(incident, null, 2)}\n---\n`;
    try { appendFileSync(qLog, entry, "utf8"); } catch {}

    this.#log("error", "INTRUSION DETECTED — quarantining", incident);
    this.emit("intrusion", incident);

    // Kill browser session immediately
    try {
      if (this.#page) await this.#page.close().catch(() => {});
      if (this.#context) await this.#context.close().catch(() => {});
      if (this.#browser) await this.#browser.close().catch(() => {});
    } catch {}
    this.#browser = null;
    this.#context = null;
    this.#page = null;

    // Emit and exit
    this._setState("quarantined", `Intrusion detected: ${reason}. Quarantine log: ${qLog}`);
    this.emit("error", {
      message: `SECURITY: Intrusion detected — ${reason}. Session quarantined. See ${qLog}`,
    });

    // Give the TUI time to render before exiting
    await delay(300);
    process.exit(1);
  }

  // -- internal: chrome lifecycle ---------------------------------------------
  async #resolveChrome() {
    const override = this.#opts.chromeBin;
    if (override && existsSync(override)) return override;
    for (const name of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
      const resolved = await new Promise((resolve) => {
        const child = spawn("bash", ["-lc", `command -v ${name}`], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        child.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
      });
      if (resolved) return resolved;
    }
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
      if (existsSync(candidate)) return candidate;
    }
    return "";
  }

  async #probeCdp() {
    try {
      const res = await fetch(`${this.#opts.cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
      const text = await res.text();
      return text.includes("webSocketDebuggerUrl");
    } catch { return false; }
  }

  async #startChrome(chromeBin) {
    mkdirSync(this.#opts.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-address=${this.#opts.host}`,
      `--remote-debugging-port=${this.#opts.cdpPort}`,
      `--user-data-dir=${this.#opts.profileDir}`,
      "--no-first-run", "--no-default-browser-check", "--new-window", this.#opts.chatUrl,
    ];
    const child = spawn(chromeBin, args, { detached: true, stdio: "ignore" });
    child.unref();
  }

  // -- internal: page interaction ---------------------------------------------
  async #detectInput() {
    for (const selector of INPUT_CANDIDATES) {
      const loc = this.#page.locator(selector).first();
      if (await loc.count().catch(() => 0)) {
        if (await loc.isVisible().catch(() => false)) return loc;
      }
    }
    return null;
  }

  async #waitForComposer() {
    while (true) {
      const input = await this.#detectInput();
      if (input) return input;
      this._setState("connecting", "Complete Claude.ai login or security verification in the browser window.");
      await this.#page.bringToFront().catch(() => {});
      await delay(1000);
    }
  }

  async #clickModelIfNeeded(modelName) {
    if (!modelName) return false;
    try {
      let trigger = null;
      for (const sel of MODEL_BUTTON_CANDIDATES) {
        const c = this.#page.locator(sel).first();
        if (await c.count().catch(() => 0)) { trigger = c; break; }
      }
      if (!trigger) return false;
      await trigger.click({ timeout: 1200 }).catch(() => {});
      await delay(150);
      const opt = this.#page.locator(`button:has-text("${modelName}")`).or(this.#page.locator(`text=${modelName}`)).first();
      if (await opt.count().catch(() => 0)) {
        await opt.click({ timeout: 1200 }).catch(() => {});
        return true;
      }
      return false;
    } catch { return false; }
  }

  async #sendToComposer(message) {
    const input = await this.#waitForComposer();
    const tag = (await input.evaluate((n) => n.tagName)).toLowerCase();
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click();
    if (tag === "textarea" || tag === "input") {
      await input.fill("");
      await input.fill(message);
    } else {
      await input.evaluate((node, text) => {
        node.focus();
        node.textContent = "";
        node.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        const inserted = document.execCommand?.("insertText", false, text);
        if (!inserted) node.textContent = text;
        node.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
        node.dispatchEvent(new InputEvent("change", { bubbles: true, composed: true }));
      }, message);
    }

    // Send: for textarea/input use Enter; for div[contenteditable] click the send button
    this.#log("debug", "sending message", { tag, len: message.length });
    if (tag === "div") {
      // Contenteditable — Enter inserts newline. Need to click the send button.
      let clicked = false;
      try {
        clicked = await input.evaluate((node) => {
          const isUsable = (button) => {
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !button.disabled;
          };
          const clickFirst = (buttons) => {
            for (const button of buttons) {
              if (isUsable(button)) {
                button.click();
                return true;
              }
            }
            return false;
          };
          const direct = [
            ...document.querySelectorAll('button[aria-label*="Send"], button[data-testid*="send"], form button[type="submit"]'),
          ];
          if (clickFirst(direct)) return true;

          const container = node.closest("form") || node.closest('[data-testid*="composer"]') || node.parentElement;
          const scoped = container ? [...container.querySelectorAll("button")] : [];
          if (clickFirst(scoped.filter((button) => /send/i.test(button.getAttribute("aria-label") || button.textContent || "")))) return true;
          return clickFirst(scoped.filter((button) => button.querySelector("svg") && !/stop/i.test(button.getAttribute("aria-label") || "")));
        });
      } catch (error) {
        this.#log("debug", "send button click failed", { error: error.message });
      }
      this.#log("debug", clicked ? "send button clicked" : "no send button found");
      if (!clicked) {
        try { await input.press("Control+Enter"); } catch {}
      }
    } else {
      try { await input.press("Enter"); } catch {}
    }
  }

  // -- internal: message parsing ----------------------------------------------
  async #parseMessages() {
    try {
      return await this.#page.evaluate(() => {
        const uiNoise = [
        "New chat", "Chats", "Projects", "Recents", "Free plan",
        "Upgrade", "Customize", "Settings", "Help", "Share",
        "Copy", "Retry", "Thumbs up", "Thumbs down", "Goblins",
        "Sonnet", "Haiku", "Opus", "Style", "Model",
      ];
      // Detect the TOOL_PREFIX block by requiring several tool names together.
      // This avoids false positives when Claude mentions one tool in a normal response.
      const toolNames = [
        "list_dir", "read_file", "write_file", "edit_file",
        "mkdir", "stat", "chmod", "shell", "start_shell", "check_process",
        "grep", "glob",
      ];
      const isToolInstructions = (text) => {
        const count = toolNames.filter((t) => text.includes(t)).length;
        return count >= 5; // 5+ tool names in one node = it's the prefix block
      };
      // Strict individual-message selectors only — no container/parent selectors.
      // We want each assistant or user message node, not the whole conversation wrapper.
      const selectors = [
        '[data-message-author]', '[data-message-id]',
        '[role="article"]', '[role="listitem"]',
      ];
      const seen = new Set();
      const nodes = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((node) => {
          if (seen.has(node)) return;
          seen.add(node);
          const raw = (node.textContent || "").replace(/[-]/g, " ").replace(/\s+/g, " ").trim();
          if (!raw || raw.length < 2) return;
          if (uiNoise.some((n) => raw === n)) return;
          if (isToolInstructions(raw)) return;
          const tag = (node.tagName || "").toLowerCase();
          if (tag === "button" || tag === "textarea" || tag === "input" || tag === "select") return;
          const rect = node.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const author = (node.getAttribute("data-message-author") || node.getAttribute("data-author") || node.getAttribute("role") || "").toLowerCase();
          const testId = (node.getAttribute("data-testid") || "").toLowerCase();
          const cls = String(node.className || "").toLowerCase();
          const isUser = author.includes("user") || author.includes("human") || testId.includes("user") || testId.includes("human") || cls.includes("user") || cls.includes("human");
          const isAssistant = author.includes("assistant") || author.includes("claude") || author.includes("bot") || testId.includes("assistant") || testId.includes("claude") || cls.includes("assistant") || cls.includes("claude");
          nodes.push({ text: raw, isUser, isAssistant });
        });
      }
      // Dedup — remove any entry whose text is fully contained in a later assistant entry
      const result = nodes.filter((e, i, a) => {
        if (i === 0) return true;
        // Skip if identical to previous (consecutive dedup)
        if (e.text === a[i - 1]?.text) return false;
        return true;
      });
      // Second pass: remove entries whose text is a substring of a nearby assistant message
      return result.filter((entry, idx, arr) => {
        // Look forward 3 entries — if an assistant message contains this text, skip
        for (let j = idx + 1; j < Math.min(idx + 4, arr.length); j++) {
          if (arr[j].isAssistant && arr[j].text.includes(entry.text) && arr[j].text.length > entry.text.length) {
            return false;
          }
        }
        return true;
      });
    });
    } catch {
      return []; // timeout or stale page — return empty
    }
  }

  async #extractConversationText() {
    try {
      return await this.#page.evaluate(() => {
        const main = document.querySelector("main") || document.body;
        const clone = main.cloneNode(true);
        clone.querySelectorAll('nav, [class*="sidebar"], [class*="Sidebar"], [class*="drawer"], [class*="Drawer"], [class*="rail"], [class*="Rail"], [role="navigation"]').forEach(el => el.remove());
        return (clone.innerText || "").replace(/\s+/g, " ").trim();
      });
    } catch {
      return "";
    }
  }

  #extractLatestResponse(conversationText) {
    // This is a FALLBACK only. The primary path is DOM-based parseMessages().
    // We only try explicit markers — no guessing at "latter portion" of page text.
    if (!conversationText) return "";
    const clean = conversationText.replace(/[-]/g, " ").replace(/\s+/g, " ").trim();
    const stops = [
      "Claude is AI and can make mistakes", "Claude finished the response",
      "New chat", "Chats", "Projects", "Recents", "Free plan", "Upgrade",
      "Share", "Sonnet", "Haiku", "Opus", "Goblins", "Customize",
      "Show more", "Thinking:", "Extended thinking",
    ];
    const trimToStop = (t) => { let b = t.length; for (const s of stops) { const i = t.indexOf(s); if (i > 0 && i < b) b = i; } return t.slice(0, b).trim(); };

    // Only use explicit markers — never guess
    const claudeIdx = clean.lastIndexOf("Claude responded:");
    if (claudeIdx !== -1) return trimToStop(clean.slice(claudeIdx + "Claude responded:".length).trim());

    const asstIdx = clean.lastIndexOf("assistant:");
    if (asstIdx !== -1) return trimToStop(clean.slice(asstIdx + "assistant:".length).trim());

    return ""; // no explicit marker found — return empty, let DOM path handle it
  }

  #extractLatestResponseAfterBaseline(conversationText, baselineText) {
    if (!conversationText) return "";
    const normalize = (text) => String(text || "").replace(/[-]/g, " ").replace(/\s+/g, " ").trim();
    const clean = normalize(conversationText);
    const baseline = normalize(baselineText);
    let suffix = clean;

    if (baseline) {
      if (clean.startsWith(baseline)) {
        suffix = clean.slice(baseline.length).trim();
      } else {
        const idx = clean.lastIndexOf(baseline);
        if (idx !== -1) suffix = clean.slice(idx + baseline.length).trim();
      }
    }

    const extracted = this.#extractLatestResponse(suffix);
    if (extracted) return extracted;
    if (/WALKIE_PROTOCOL_V1|<tool_result>|Tool result for /.test(suffix)) return "";
    return "";
  }

  async #isStreaming() {
    for (const sel of STOP_BUTTON_CANDIDATES) {
      const loc = this.#page.locator(sel).first();
      if (await loc.count().catch(() => 0)) {
        if (await loc.isVisible().catch(() => false)) return true;
      }
    }
    return false;
  }

  #pickLatestAssistantText(messages, baselineCount, userPrompt) {
    const start = Math.min(Math.max(baselineCount, 0), messages.length);
    let candidates = messages.slice(start).filter((item) => item.text);
    if (userPrompt) {
      const userIdx = candidates.map((e, i) => ({ e, i: start + i })).findLast((item) => item.e.isUser || item.e.text.includes(userPrompt));
      if (userIdx) candidates = messages.slice(userIdx.i + 1).filter((item) => item.text);
    }
    const marked = candidates.filter((item) => item.isAssistant);
    if (marked.length) return marked.at(-1)?.text || "";
    const safeUnmarked = candidates.filter((item) => {
      if (userPrompt && item.text.includes(userPrompt)) return false;
      if (item.text.includes("WALKIE_PROTOCOL_V1")) return false;
      if (item.text.includes("Nonce for this turn:")) return false;
      return true;
    });
    return safeUnmarked.at(-1)?.text || "";
  }

  #stripToolInstructions(text, userPrompt) {
    if (!text) return text;
    let cleaned = String(text);
    // Old ◁/▷ markers
    const start = cleaned.indexOf("◁");
    const end = cleaned.indexOf("▷");
    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(0, start) + " " + cleaned.slice(end + 1);
    } else if (start !== -1) {
      cleaned = cleaned.slice(0, start).trim();
    }

    const protocolIdx = cleaned.indexOf("WALKIE_PROTOCOL_V1");
    if (protocolIdx !== -1) {
      const userIdx = cleaned.indexOf("User request:", protocolIdx);
      if (userIdx !== -1 && userPrompt) {
        const afterUser = cleaned.indexOf(userPrompt, userIdx);
        if (afterUser !== -1) {
          cleaned = cleaned.slice(0, protocolIdx) + cleaned.slice(afterUser + userPrompt.length);
        }
      } else {
        const endHint = "Use absolute paths. After a tool result, answer normally or request another tool.";
        const endIdx = cleaned.indexOf(endHint, protocolIdx);
        if (endIdx !== -1) cleaned = cleaned.slice(0, protocolIdx) + cleaned.slice(endIdx + endHint.length);
      }
    }

    // New format: strip "This chat is connected to a Linux terminal" prefix
    const prefixes = [
      "This chat is connected to a Linux terminal",
      "You have shell access to this Linux PC",
      "Connected to local PC tools.",
    ];
    for (const p of prefixes) {
      const idx = cleaned.indexOf(p);
      if (idx !== -1) {
        // Find the end of the tool prefix (typically ends before the user's actual query)
        const after = cleaned.slice(idx + p.length);
        // Try to find where instructions end and user message begins
        const userMarkers = ["Never say you cannot", "Do not ask the user", "For long-running"];
        let cutPoint = after.length;
        for (const m of userMarkers) {
          const mi = after.indexOf(m);
          if (mi !== -1 && mi + m.length + 30 < cutPoint) {
            cutPoint = mi + m.length + 30;
          }
        }
        cleaned = (cleaned.slice(0, idx) + after.slice(Math.min(cutPoint, after.length))).trim();
      }
    }
    return cleaned.replace(/\s+/g, " ").trim();
  }

  async #latestAssistantText(baselineCount, baselineText, userPrompt) {
    const dedupRepeatedPhrases = (text) => {
      const value = String(text || "").trim();
      if (!value) return "";
      const compact = (part) => part.replace(/[^a-z0-9]/gi, "").toLowerCase();
      for (let split = 4; split <= Math.min(300, value.length - 4); split++) {
        const left = value.slice(0, split).trim();
        const right = value.slice(split).trim();
        if (left && right && compact(left) === compact(right)) {
          const leftPunctuation = (left.match(/[^a-z0-9]/gi) || []).length;
          const rightPunctuation = (right.match(/[^a-z0-9]/gi) || []).length;
          return rightPunctuation >= leftPunctuation ? right : left;
        }
      }
      const half = Math.floor(value.length / 2);
      if (value.length % 2 === 0 && value.slice(0, half) === value.slice(half)) {
        return value.slice(0, half).trim();
      }
      const exactWithSpace = value.match(/^(.{4,300}?)\s+\1$/s);
      if (exactWithSpace) return exactWithSpace[1].trim();
      const prefixRepeat = value.match(/^(.{4,300}?)\s*\1\s+(.+)$/s);
      if (prefixRepeat) return `${prefixRepeat[1].trim()} ${prefixRepeat[2].trim()}`;
      return value;
    };
    const clean = (t) => dedupRepeatedPhrases(this.#stripToolInstructions(t, userPrompt));

    const conv = await this.#extractConversationText();
    const explicit = this.#extractLatestResponseAfterBaseline(conv, baselineText);
    if (explicit) return clean(explicit);

    try {
      const msgs = await this.#parseMessages();
      const parsed = this.#pickLatestAssistantText(msgs, baselineCount, userPrompt);
      if (parsed && parsed.length > 1) {
        const cleaned = clean(parsed);
        const base = clean(baselineText);
        if (cleaned && cleaned !== base && !cleaned.includes("<tool_result>") && !cleaned.includes("Tool result for ")) {
          return cleaned;
        }
      }
    } catch { /* DOM parse failed, fall through */ }

    if (!conv) return "";
    const extracted = this.#extractLatestResponse(conv);
    if (extracted && extracted !== baselineText) return clean(extracted);

    if (baselineText && conv.startsWith(baselineText)) {
      const suffix = clean(conv.slice(baselineText.length).trim());
      if (!suffix || suffix.includes(userPrompt) || suffix.includes("WALKIE_PROTOCOL_V1")) return "";
      if (suffix.length > 1) return suffix;
    }

    return "";
  }

  async #streamResponse(baselineCount, baselineText, userMessage) {
    let lastText = "";
    let stableTicks = 0;
    const endAt = Date.now() + this.#opts.timeoutMs;
    this.#log("debug", "streamResponse started", { baselineCount, baselineText: baselineText?.slice(0, 50) });
    while (Date.now() < endAt) {
      await delay(250);
      let current;
      try {
        current = await this.#latestAssistantText(baselineCount, baselineText, userMessage);
      } catch (error) {
        this.#log("debug", "latestAssistantText threw", { error: error.message });
        current = "";
      }

      if (stableTicks === 0 || stableTicks % 4 === 0) {
        this.#log("debug", "stream poll", {
          stableTicks,
          hasCurrent: Boolean(current),
          len: current?.length || 0,
          lastLen: lastText?.length || 0,
        });
      }

      const curLen = current?.length || 0;
      const lastLen = lastText?.length || 0;
      if (curLen > 0 && curLen > lastLen + 5) {
        const delta = current.slice(lastLen);
        if (delta.trim() && !/<tool_?call\b/i.test(current)) this.emit("delta", { text: delta });
        lastText = current;
        stableTicks = 0;
        continue;
      }

      if (curLen > 0 && current !== lastText && !current.startsWith(lastText)) {
        lastText = current;
        stableTicks = 0;
        continue;
      }

      stableTicks += 1;
      const stillStreaming = await this.#isStreaming();
      if (lastText && !stillStreaming && stableTicks >= 6) return lastText;
    }
    if (lastText) return lastText;
    this.#log("error", "streamResponse timed out with no text", { baselineCount });
    throw new Error("No response text captured from claude.ai. The page UI may have changed.");
  }

  async #askClaude(message, userMessageForAnchor) {
    const baselineMessages = await this.#parseMessages();
    const baselineText = await this.#extractConversationText() || "";
    const baselineExtract = this.#extractLatestResponse(baselineText) || baselineText;
    this.emit("assistant-start", {});
    await this.#sendToComposer(message);
    return this.#streamResponse(baselineMessages.length, baselineExtract, userMessageForAnchor || message);
  }

  // -- internal: tool execution -----------------------------------------------
  async #executeTool(call) {
    const name = call.name;
    const args = call.arguments || {};

    if (name === "list_dir") {
      const target = await this.#assertPathAllowed(resolveLocalPath(args.path));
      const entries = await readdir(target, { withFileTypes: true });
      return {
        path: target,
        entries: entries.slice(0, 500).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other",
        })),
        truncated: entries.length > 500,
      };
    }

    if (name === "read_file") {
      const target = await this.#assertPathAllowed(resolveLocalPath(args.path));
      const maxBytes = Math.min(Number(args.max_bytes || 200000), 1000000);
      const data = await readFile(target);
      return {
        path: target, bytes: data.length, truncated: data.length > maxBytes,
        content: data.slice(0, maxBytes).toString("utf8"),
      };
    }

    if (name === "write_file") {
      const target = await this.#assertPathAllowed(resolveLocalPath(args.path));
      const content = String(args.content ?? "");
      await makeDir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { path: target, bytes_written: Buffer.byteLength(content) };
    }

    if (name === "edit_file") {
      const target = await this.#assertPathAllowed(resolveLocalPath(args.path));
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      if (!oldStr) throw new Error("edit_file requires old_string (the exact text to replace).");
      const data = await readFile(target, "utf8");
      let count = 0;
      let pos = data.indexOf(oldStr);
      while (pos !== -1) { count++; pos = data.indexOf(oldStr, pos + 1); }
      if (count === 0) throw new Error(`old_string was not found in ${target}. It must match exactly (including whitespace).`);
      if (count > 1) throw new Error(`old_string matched ${count} times in ${target}. It must be unique. Include more surrounding context.`);
      const updated = data.replace(oldStr, newStr);
      await writeFile(target, updated, "utf8");
      return { path: target, replaced: true, bytes_before: Buffer.byteLength(data), bytes_after: Buffer.byteLength(updated) };
    }

    if (name === "mkdir") {
      const target = await this.#assertPathAllowed(resolveLocalPath(args.path));
      await makeDir(target, { recursive: true });
      return { path: target, created: true };
    }

    if (name === "stat") {
      const target = await this.#assertPathAllowed(resolveLocalPath(args.path));
      const info = await statPath(target);
      return {
        path: target,
        type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        size: info.size, mode: `0${(info.mode & 0o777).toString(8)}`,
        uid: info.uid, gid: info.gid,
        atime: info.atime.toISOString(), mtime: info.mtime.toISOString(), ctime: info.ctime.toISOString(),
      };
    }

    if (name === "chmod") {
      const target = await this.#assertPathAllowed(resolveLocalPath(args.path));
      const modeText = String(args.mode || "").trim();
      if (!/^[0-7]{3,4}$/.test(modeText)) throw new Error("chmod mode must be octal, e.g. 755 or 0644.");
      await chmodPath(target, Number.parseInt(modeText, 8));
      const info = await statPath(target);
      return { path: target, mode: `0${(info.mode & 0o777).toString(8)}` };
    }

    if (name === "shell") {
      const command = String(args.command || "").trim();
      if (!command) throw new Error("shell command is required.");
      const cwd = await this.#assertPathAllowed(args.cwd ? resolveLocalPath(args.cwd) : os.homedir(), "cwd");
      const timeoutMs = Math.min(Number(args.timeout_ms || 30000), 120000);
      return { command, cwd, ...(await runShell(command, cwd, timeoutMs)) };
    }

    if (name === "start_shell") {
      const command = String(args.command || "").trim();
      if (!command) throw new Error("start_shell command is required.");
      const cwd = await this.#assertPathAllowed(args.cwd ? resolveLocalPath(args.cwd) : os.homedir(), "cwd");
      const logPath = await this.#assertPathAllowed(args.log_path ? resolveLocalPath(args.log_path) : path.join(os.tmpdir(), `claude-job-${Date.now()}.log`), "log_path");
      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms || 3_600_000), 10_000), 21_600_000);
      return startShellJob(command, cwd, logPath, timeoutMs);
    }

    if (name === "check_process") {
      const logPath = args.log_path ? await this.#assertPathAllowed(resolveLocalPath(args.log_path), "log_path") : null;
      const pid = Number(args.pid || 0);
      const tailBytes = Math.min(Number(args.tail_bytes || 20000), 200000);
      let alive = false;
      if (pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      }
      let logTail = "";
      if (logPath && existsSync(logPath)) {
        const data = await readFile(logPath);
        logTail = data.slice(Math.max(0, data.length - tailBytes)).toString("utf8");
      }
      return { pid, alive, log_path: logPath, log_tail_bytes: Buffer.byteLength(logTail), log_tail: truncateText(logTail, tailBytes) };
    }

    if (name === "grep") {
      const target = await this.#assertPathAllowed(resolveLocalPath(args.pattern ? (args.path || ".") : (args.path || ".")));
      const patternStr = String(args.pattern || "");
      if (!patternStr) throw new Error("grep requires a pattern (regex string).");
      const maxResults = Math.min(Number(args.max_results || 200), 1000);
      const results = [];
      let regex;
      try { regex = new RegExp(patternStr, "gi"); } catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

      const searchFile = async (filePath) => {
        if (results.length >= maxResults) return;
        try {
          const data = await readFile(filePath, "utf8");
          const lines = data.split("\n");
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (regex.test(lines[i])) {
              regex.lastIndex = 0;
              results.push({ path: filePath, line: i + 1, content: lines[i].slice(0, 500) });
            }
          }
        } catch { /* binary or unreadable */ }
      };

      const stat = await statPath(target).catch(() => null);
      if (!stat) throw new Error(`Path not found: ${target}`);
      if (stat.isFile()) {
        await searchFile(target);
      } else {
        const queue = [target];
        while (queue.length && results.length < maxResults) {
          const dir = queue.shift();
          try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const e of entries) {
              if (results.length >= maxResults) break;
              if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".git") continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) queue.push(full);
              else if (e.isFile()) await searchFile(full);
            }
          } catch { /* permission denied */ }
        }
      }
      return { pattern: patternStr, results: results.slice(0, maxResults), total_matches: results.length, truncated: results.length > maxResults };
    }

    if (name === "glob") {
      const pattern = String(args.pattern || "**/*");
      const cwd = await this.#assertPathAllowed(args.path ? resolveLocalPath(args.path) : process.cwd());
      const matches = [];
      try {
        for await (const entry of fsGlob(pattern, { cwd, withFileTypes: false, exclude: (p) => p.includes("node_modules") || p.includes(".git") })) {
          if (matches.length >= 100) break;
          matches.push(typeof entry === "string" ? entry : entry.path || String(entry));
        }
      } catch (e) { throw new Error(`Glob failed: ${e.message}`); }
      return { pattern, cwd, matches, count: matches.length, truncated: matches.length >= 100 };
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  // -- internal: tool loop ----------------------------------------------------
  #buildUserPrompt(text, nonce) {
    const cleaned = this.#sanitizeInput(text);
    const prompt = this.#opts.toolPrompt || TOOL_PREFIX;
    return `${prompt.replaceAll("NONCE", nonce)}\n\nNonce for this turn: ${nonce}\nUser request:\n${cleaned}`;
  }

  #buildToolResultPrompt(call, result) {
    const payload = truncateText(JSON.stringify(result, null, 2), 200000);
    return [
      `Tool result for ${call.name}:`,
      `<tool_result>${payload}</tool_result>`,
      `Use this result to continue. If another local tool is needed, return exactly one <tool_call nonce="${call.nonce || ""}"> JSON block. Otherwise answer the user normally.`,
    ].join("\n");
  }

  // Patterns Claude uses to deny having tools. If the response contains one of
  // these AND no tool call, we retry with an override that forces tool use.
  #DENIAL_PATTERNS = [
    /I (do not|don't) have access/i,
    /I (cannot|can't) access/i,
    /(sandbox|container).*(can't|cannot|don't)/i,
    /I('?m| am) (just )?a (chatbot|language model)/i,
    /I (can't|cannot|don't) (run|execute) (commands|shell)/i,
    /upload (it|the file|them)/i,
    /paste (it|the content|the file)/i,
    /I (can't|couldn't|won't) (connect to|reach|access) your/i,
  ];

  #isDenialResponse(text) {
    if (!text) return false;
    const short = text.slice(0, 800); // only check the beginning
    return this.#DENIAL_PATTERNS.some((p) => p.test(short));
  }

  async #runWithTools(text) {
    if (!this.#opts.enableTools) {
      const cleaned = this.#sanitizeInput(text);
      return this.#askClaude(cleaned, text);
    }

    const nonce = makeNonce();
    const seenToolCalls = new Set();
    let response = await this.#askClaude(this.#buildUserPrompt(text, nonce), text);

    // If Claude denies having tools, retry once with an override that forces
    // it to stop denying and USE the tools. Claude sometimes defaults to
    // "I'm just a chatbot" even though the TOOL_PREFIX says otherwise.
    if ((this.#isDenialResponse(response) || isProtocolFailure(response)) && !extractToolCall(response, nonce)) {
      this.#log("warn", "denial detected, retrying with nudge");
      const nudge = [
        "Protocol correction: you do not directly inspect your sandbox.",
        `If local access is needed, request the wrapper tool using <tool_call nonce="${nonce}">JSON</tool_call>.`,
        "Do not mention /home/claude, /home/ubuntu, /mnt/user-data, uploads, or sandbox paths.",
      ].join(" ");
      const retryPrompt = `${nudge}\n\n${text}`;
      response = await this.#askClaude(retryPrompt, text);
    }

    for (let round = 0; round < this.#opts.toolLoopLimit; round++) {
      const call = extractToolCall(response, nonce);
      if (!call) {
        this.#log("debug", "no tool call extracted", { respLen: response?.length || 0, preview: response?.slice(0, 120) });
        return response;
      }
      const callKey = JSON.stringify({ name: call.name, arguments: call.arguments || {} });
      if (seenToolCalls.has(callKey)) {
        this.#log("warn", "duplicate tool call ignored", { name: call.name });
        return response;
      }
      seenToolCalls.add(callKey);

      this.#log("info", `tool call round ${round + 1}`, { name: call.name });
      this.emit("tool-call", { name: call.name, arguments: call.arguments, round: round + 1 });

      // Intrusion detection — runs before security check, can trigger quarantine
      const safe = await this.#checkIntrusion(call);
      if (!safe) return response; // unreachable if quarantined, but defensive

      // Security check + confirmation
      const risk = this.#assessRisk(call.name, call.arguments || {});
      const approved = await this.#confirmTool(call, risk);

      let result;
      if (!approved) {
        result = {
          ok: false,
          error: risk.blocked
            ? `Blocked by security policy: ${risk.reasons.join(", ")}`
            : "Operation requires user confirmation. Denied.",
        };
        this.#log("warn", "tool denied", { name: call.name, reasons: risk.reasons });
      } else {
        try {
          result = { ok: true, result: await this.#executeTool(call) };
          this.#log("info", "tool result ok", { name: call.name });
        } catch (error) {
          result = { ok: false, error: error.message };
          this.#log("error", "tool result failed", { name: call.name, error: error.message });
        }
      }

      // Audit every tool execution
      this.#audit({
        tool: call.name,
        args: truncateText(JSON.stringify(call.arguments || {}), 2000),
        ok: result.ok,
        risk: risk.reasons,
        approved,
      });

      this.emit("tool-result", { name: call.name, ok: result.ok, output: result });
      const resultPrompt = this.#buildToolResultPrompt(call, result);
      response = await this.#askClaude(resultPrompt, resultPrompt);
    }
    this.#log("warn", "tool loop limit reached");
    this.emit("error", { message: "Stopped after tool loop limit to avoid an infinite loop." });
    return response;
  }
}

// convenience factory
export function createSession(options) {
  return new ClaudeFreeSession(options);
}

export { extractToolCall as __extractToolCallForTest };

// re-export the class as default as well
export default ClaudeFreeSession;
