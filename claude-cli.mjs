#!/usr/bin/env node
// claude-cli.mjs — console agent for the claude.ai local wrapper.
import { ClaudeFreeSession } from "./claude-free-api.mjs";
import readline from "node:readline";

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

const youPrompt = `${C.bold}${C.green}you>${C.reset} `;
const claudePrompt = `${C.bold}${C.cyan}claude>${C.reset} `;
const info = (text) => `${C.dim}${text}${C.reset}`;

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && i < args.length - 1 ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);

const session = new ClaudeFreeSession({
  cdpPort: Number(argValue("--cdp-port", process.env.CLAUDE_CDP_PORT || "9222")),
  targetModel: argValue("--model", process.env.CLAUDE_SONNET_MODEL || "Sonnet 4.6 Max"),
  timeoutMs: Number(argValue("--timeout", process.env.CLAUDE_RESPONSE_TIMEOUT || "120000")),
  chromeBin: argValue("--chrome-bin", process.env.CLAUDE_CHROME_BIN || ""),
});

let rl;
let answerBuffer = "";
let assistantOpen = false;

function writeLine(text = "") {
  process.stdout.write(`${text}\n`);
}

function redrawPrompt() {
  rl?.prompt();
}

function closePromptLine() {
  if (!assistantOpen) {
    process.stdout.write(claudePrompt);
    assistantOpen = true;
  }
}

async function askConfirm(call, risk) {
  const reasons = risk?.reasons?.length ? risk.reasons.join(", ") : "confirmation required";
  writeLine("");
  writeLine(`${C.yellow}confirm>${C.reset} ${call.name} (${reasons})`);
  writeLine(info(JSON.stringify(call.arguments || {}, null, 2).slice(0, 2000)));
  return new Promise((resolve) => {
    rl.question(`${C.yellow}allow? [y/N]${C.reset} `, (answer) => {
      resolve(/^y(es)?$/i.test(answer.trim()));
      redrawPrompt();
    });
  });
}

session.setConfirmCallback(askConfirm);

session.on("state-change", ({ state, detail }) => {
  if (state === "connecting") {
    process.stderr.write(`${info(`[connecting] ${detail || state}`)}\r`);
  } else if (state === "ready") {
    writeLine(`\n${info(`[connected] ${detail || state}`)}`);
  } else if (state === "busy") {
    answerBuffer = "";
    assistantOpen = false;
  } else if (state === "error") {
    writeLine(`${C.red}[error]${C.reset} ${detail || state}`);
  }
});

session.on("assistant-start", () => {
  answerBuffer = "";
  assistantOpen = false;
});

session.on("delta", ({ text }) => {
  if (!text) return;
  closePromptLine();
  answerBuffer += text;
  process.stdout.write(text);
});

session.on("tool-call", ({ name, arguments: toolArgs, round }) => {
  if (assistantOpen) writeLine("");
  assistantOpen = false;
  writeLine(`${C.yellow}tool>${C.reset} ${name}${round ? ` round ${round}` : ""}`);
  const preview = JSON.stringify(toolArgs || {}, null, 2);
  if (preview && preview !== "{}") writeLine(info(preview.slice(0, 2000)));
});

session.on("tool-result", ({ name, ok, output }) => {
  const marker = ok ? `${C.green}ok${C.reset}` : `${C.red}failed${C.reset}`;
  writeLine(`${C.yellow}tool>${C.reset} ${name} ${marker}`);
  const result = output?.result || output?.error || output;
  if (typeof result === "string") {
    writeLine(info(result.slice(0, 3000)));
  } else if (result?.stdout) {
    process.stdout.write(result.stdout);
  } else if (result?.stderr) {
    process.stderr.write(result.stderr);
  } else if (result?.content) {
    process.stdout.write(result.content.slice(0, 3000));
  }
});

session.on("done", () => {
  if (assistantOpen) writeLine("");
  assistantOpen = false;
  redrawPrompt();
});

session.on("error", ({ message }) => {
  if (assistantOpen) writeLine("");
  assistantOpen = false;
  writeLine(`${C.red}[error]${C.reset} ${message}`);
  redrawPrompt();
});

async function shutdown() {
  writeLine("");
  rl?.close();
  await session.close().catch(() => {});
  process.exit(0);
}

writeLine(info("Claude Walkie CLI: connecting to Claude.ai with local file tools."));
writeLine(info("Complete login/security verification in Chrome if prompted."));
await session.connect();
if (!hasFlag("--keep-chat")) {
  await session.newChat().catch(() => {});
  writeLine(info("[fresh chat]"));
}

rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: youPrompt,
});

rl.on("SIGINT", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) {
    redrawPrompt();
    return;
  }

  if (text === "/exit" || text === "/quit") {
    await shutdown();
    return;
  }

  if (text === "/help") {
    writeLine(info("/exit, /quit  quit"));
    writeLine(info("/new         fresh Claude chat"));
    writeLine(info("/status      connection/model state"));
    writeLine(info("/tools       local tool list"));
    writeLine(info("/help        show this help"));
    redrawPrompt();
    return;
  }

  if (text === "/status") {
    writeLine(info(`state=${session.state || "unknown"} model=${session.model}`));
    redrawPrompt();
    return;
  }

  if (text === "/tools") {
    writeLine(info("list_dir read_file write_file edit_file mkdir stat chmod shell start_shell check_process grep glob"));
    redrawPrompt();
    return;
  }

  if (text === "/new") {
    await session.newChat().catch(() => {});
    writeLine(info("[fresh chat]"));
    redrawPrompt();
    return;
  }

  try {
    await session.send(text);
  } catch (error) {
    writeLine(`${C.red}[error]${C.reset} ${error.message}`);
    redrawPrompt();
  }
});

redrawPrompt();
