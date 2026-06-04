#!/usr/bin/env node
// claude-free-tui.mjs — Terminal chat UI for claude.ai free tier.
// Full-screen ANSI TUI. No dependencies beyond Node built-ins + claude-free-api.mjs.
import { ClaudeFreeSession } from "./claude-free-api.mjs";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// ── ANSI constants ───────────────────────────────────────────────────────────
const CSI = "\x1b[";
const ALT_SCREEN = CSI + "?1049h";
const NORMAL_SCREEN = CSI + "?1049l";
const HIDE_CURSOR = CSI + "?25l";
const SHOW_CURSOR = CSI + "?25h";
const DISABLE_MOUSE = CSI + "?1000l" + CSI + "?1002l" + CSI + "?1003l" + CSI + "?1006l" + CSI + "?1015l";
const RESET = CSI + "0m";
const HOME = CSI + "H";
const CLEAR_LINE = CSI + "K";
const CLEAR_BELOW = CSI + "J";

const SGR = {
  reset: CSI + "0m",
  bold: CSI + "1m",
  dim: CSI + "2m",
  inverse: CSI + "7m",
  cyan: CSI + "36m",
  green: CSI + "32m",
  yellow: CSI + "33m",
  red: CSI + "31m",
  brightBlack: CSI + "90m",
};

function color(str, ...codes) {
  return codes.join("") + str + SGR.reset;
}

// Display-width-aware truncation that never cuts inside ANSI escape sequences.
// Counts only visible characters, preserves all SGR codes.
function truncate(str, maxVisible) {
  const out = [];
  let visible = 0;
  let inEscape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\x1b") inEscape = true;
    out.push(ch);
    if (inEscape) {
      if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) inEscape = false;
      continue;
    }
    visible++;
    if (visible >= maxVisible) break;
  }
  if (visible < (str.replace(/\x1b\[[0-9;]*m/g, "").length)) {
    out.push("…");
  }
  return out.join("");
}

// ── TUI class ────────────────────────────────────────────────────────────────
class ClaudeFreeTUI {
  #session;
  #rows = 24;
  #cols = 80;
  #messages = [];
  #inputBuf = "";
  #cursorPos = 0;
  #scrollOffset = 0;
  #history = [];
  #historyIdx = -1;
  #savedInput = "";
  #statusText = "connecting";
  #statusState = "disconnected";
  #busy = false;
  #running = false;
  // Confirmation prompt state
  #confirming = false;
  #confirmResolve = null;
  #confirmCall = null;
  #confirmRisk = null;

  constructor(session) {
    this.#session = session;
  }

  // Called by main() after construction — registers the confirm callback
  // with the API so dangerous tool calls prompt the user in the TUI.
  #installConfirmCallback() {
    this.#session.setConfirmCallback((call, risk) => this.#showConfirm(call, risk));
  }

  // Show an inline confirmation prompt. Returns a Promise that resolves
  // when the user presses y/n.
  #showConfirm(call, risk) {
    return new Promise((resolve) => {
      this.#confirming = true;
      this.#confirmResolve = resolve;
      this.#confirmCall = call;
      this.#confirmRisk = risk;
      this.#render();
    });
  }

  // ── public ────────────────────────────────────────────────────────────────
  async start() {
    if (!process.stdin.isTTY) {
      console.error("claude-free-tui requires a terminal (TTY).");
      process.exit(1);
    }
    this.#running = true;
    this.#getSize();
    this.#setupTerminal();
    this.#wireEvents();
    this.#installConfirmCallback();
    this.#render();
    this.#readStdin(); // BEFORE connect — so keystrokes work during connection phase

    try {
      await this.#session.connect();
    } catch (err) {
      this.#addMessage("error", `Connection failed: ${err.message}`);
      this.#statusState = "error";
      this.#statusText = err.message;
      this.#render();
    }
  }

  stop() {
    if (!this.#running) return;
    this.#running = false;
    process.stdin.setRawMode(false);
    process.stdout.write(DISABLE_MOUSE + SHOW_CURSOR + NORMAL_SCREEN + RESET);
    this.#session.close().catch(() => {});
    process.exit(0);
  }

  // ── terminal setup ────────────────────────────────────────────────────────
  #setupTerminal() {
    process.stdout.write(DISABLE_MOUSE + ALT_SCREEN + HIDE_CURSOR + RESET);
    process.stdin.setRawMode(true);
    // Explicitly disable echo via termios — setRawMode should do this, but
    // some terminal emulators re-enable it. Writing the control sequence
    // directly ensures local echo is off.
    process.stdout.write("\x1b[12l"); // disable local echo (DEC mode)
    process.stdin.resume();
    process.on("SIGWINCH", () => { this.#getSize(); this.#render(); });
    process.on("SIGINT", () => this.#handleCtrlC());
    process.on("SIGTERM", () => this.stop());
  }

  #getSize() {
    this.#rows = process.stdout.rows || 24;
    this.#cols = process.stdout.columns || 80;
  }

  // ── event wiring ──────────────────────────────────────────────────────────
  #wireEvents() {
    const safe = (fn) => (...args) => { try { fn(...args); } catch { /* never crash on render */ } };

    this.#session.on("state-change", safe(({ state, detail }) => {
      this.#statusState = state;
      this.#statusText = detail || state;
      this.#busy = state === "busy";
      this.#render();
    }));

    this.#session.on("user", safe(({ text }) => {
      this.#addMessage("user", text);
      this.#render();
    }));

    this.#session.on("delta", safe(({ text }) => {
      const last = this.#messages.at(-1);
      if (last && last.role === "assistant" && !last.done) {
        last.content += text;
      } else {
        this.#addMessage("assistant", text, false);
      }
      this.#scrollOffset = 0;
      this.#render();
    }));

    this.#session.on("assistant-start", () => {
      // next delta will create the message
    });

    this.#session.on("tool-call", safe(({ name, arguments: args, round }) => {
      this.#addMessage("tool-call", { name, args, round });
      this.#scrollOffset = 0;
      this.#render();
    }));

    this.#session.on("tool-result", safe(({ name, ok, output }) => {
      this.#addMessage("tool-result", { name, ok, output });
      this.#scrollOffset = 0;
      this.#render();
    }));

    this.#session.on("done", safe(() => {
      const last = this.#messages.at(-1);
      if (last && last.role === "assistant") last.done = true;
      this.#busy = false;
      this.#render();
    }));

    this.#session.on("error", safe(({ message }) => {
      this.#addMessage("error", message);
      this.#render();
    }));

    this.#session.on("intrusion", safe((incident) => {
      this.#addMessage("error", [
        "╔══════════════════════════════════════════╗",
        "║   INTRUSION DETECTED — QUARANTINED      ║",
        "╠══════════════════════════════════════════╣",
        `║  Reason: ${incident.reason.padEnd(33)}║`,
        `║  Tool:   ${incident.tool.padEnd(33)}║`,
        `║  Score:  ${String(incident.cumulativeScore).padEnd(33)}║`,
        "╠══════════════════════════════════════════╣",
        "║  Session terminated.                    ║",
        `║  Log: ~/.cache/claude-free-quarantine.log║`,
        "╚══════════════════════════════════════════╝",
      ].join("\n"));
      this.#render();
      // Stop taking input
      this.#busy = true;
      this.#statusState = "quarantined";
      this.#statusText = `Quarantined: ${incident.reason}`;
      this.#render();
    }));
  }

  // ── message store ─────────────────────────────────────────────────────────
  #addMessage(role, content, done = true) {
    this.#messages.push({ role, content, done, ts: Date.now() });
    // cap at 500 messages
    if (this.#messages.length > 500) this.#messages = this.#messages.slice(-500);
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  #render() {
    if (!this.#running) return;
    try {
      this.#renderUnsafe();
    } catch {
      // never let a render crash kill the process
    }
  }

  #renderUnsafe() {
    const screen = [];
    // When confirming, we need an extra row for the prompt bar
    const extraRows = this.#confirming ? 1 : 0;
    const chromeRows = 3 + extraRows; // status + divider + input + optional confirm bar
    const msgAreaRows = Math.max(1, this.#rows - chromeRows);

    // Row 0: status bar
    screen.push(this.#statusBar());
    // Rows 1..msgAreaRows: messages
    const msgLines = this.#messageLines(msgAreaRows);
    for (let i = 0; i < msgAreaRows; i++) {
      screen.push((msgLines[i] || "") + CLEAR_LINE);
    }

    // Confirmation prompt bar (if active)
    if (this.#confirming) {
      const callName = this.#confirmCall?.name || "?";
      const reasons = (this.#confirmRisk?.reasons || []).join(", ");
      const echo = this.#confirmInputBuf
        ? color(` [ignored: ${this.#confirmInputBuf}]`, SGR.red + SGR.dim)
        : "";
      const bar = color(" CONFIRM ", SGR.yellow + SGR.bold + SGR.inverse)
        + color(` ${callName} `, SGR.yellow + SGR.bold)
        + color(`[${reasons}] `, SGR.yellow)
        + color(`Press Y=approve N=deny Ctrl+C=quit`, SGR.bold)
        + echo;
      screen.push(this.#truncDisplay(bar) + CLEAR_LINE);
    }

    // Divider
    screen.push(
      color("─".repeat(Math.min(this.#cols, 200)), SGR.brightBlack + SGR.dim) + CLEAR_LINE
    );
    // Input line (last visible row, or second-to-last if confirming)
    screen.push(this.#inputLine());

    // Write all at once
    process.stdout.write(HOME + screen.join("\n"));

    // Position cursor on the input row
    const inputRow = this.#rows; // 1-based, last row
    const promptLen = 2;
    if (this.#confirming) {
      // During confirmation, cursor stays out of the way (end of confirm bar)
      process.stdout.write(CSI + (inputRow - 1) + ";" + this.#cols + "H");
    } else {
      process.stdout.write(CSI + inputRow + ";" + (promptLen + this.#cursorPos + 1) + "H");
    }
  }

  #truncDisplay(str) {
    return truncate(str, this.#cols - 1);
  }

  #statusBar() {
    const stateColors = {
      connecting: SGR.yellow,
      ready: SGR.green + SGR.bold,
      busy: SGR.cyan,
      disconnected: SGR.dim,
      error: SGR.red + SGR.bold,
    };
    const sc = stateColors[this.#statusState] || SGR.dim;
    const left = `${sc}[${this.#statusState.toUpperCase()}]${SGR.reset} ${this.#statusText}`;
    const model = this.#session.model || "claude.ai";
    const right = `Claude AI Free — ${model}`;
    const avail = this.#cols - 1;
    const leftClean = left.replace(/\x1b\[[0-9;]*m/g, "");
    const rightClean = right.replace(/\x1b\[[0-9;]*m/g, "");
    if (leftClean.length + rightClean.length + 2 <= avail) {
      const pad = " ".repeat(avail - leftClean.length - rightClean.length);
      return SGR.inverse + " " + left + pad + right + " " + SGR.reset + CLEAR_LINE;
    }
    return SGR.inverse + " " + truncate(left, avail - 2) + " " + SGR.reset + CLEAR_LINE;
  }

  #messageLines(areaRows) {
    // Build an array of rendered message lines, then apply scroll offset
    const allLines = [];
    for (const msg of this.#messages) {
      const rendered = this.#renderMessage(msg);
      allLines.push(...rendered);
    }
    const maxScroll = Math.max(0, allLines.length - areaRows);
    this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));
    const start = Math.max(0, allLines.length - areaRows - this.#scrollOffset);
    return allLines.slice(start, start + areaRows);
  }

  #renderMessage(msg) {
    const w = Math.min(this.#cols, 200);
    switch (msg.role) {
      case "user":
        return this.#wrapLines(color("> ", SGR.cyan + SGR.bold) + msg.content, w, SGR.cyan);
      case "assistant":
        return this.#wrapLines(msg.content, w, "");
      case "tool-call": {
        const { name, args, round } = msg.content;
        const header = color(`── tool_call: ${name} (round ${round}) ` + "─".repeat(8), SGR.yellow + SGR.dim);
        const body = truncate(JSON.stringify(args, null, 2), 3000);
        return [header, ...this.#wrapLines(body, w - 2, SGR.dim)];
      }
      case "tool-result": {
        const { name, ok } = msg.content;
        const marker = ok ? color(" ✓", SGR.green) : color(" ✗", SGR.red);
        const header = color(`── tool_result: ${name}${marker} ` + "─".repeat(8), ok ? SGR.green + SGR.dim : SGR.red + SGR.dim);
        const output = msg.content.output;
        const body = truncate(JSON.stringify(output, null, 2), 5000);
        return [header, ...this.#wrapLines(body, w - 2, SGR.dim)];
      }
      case "error":
        return this.#wrapLines(color(msg.content, SGR.red), w, "");
      default:
        return this.#wrapLines(String(msg.content), w, "");
    }
  }

  #wrapLines(text, width, prefixSgr) {
    const lines = [];
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
    let i = 0;
    while (i < clean.length) {
      let end = i + width;
      if (end < clean.length) {
        // Try to break at a word boundary (space, dash, or punctuation)
        let breakAt = -1;
        for (let j = end; j > i + width * 0.6; j--) {
          if (clean[j] === " " || clean[j] === "\n" || clean[j] === "-" || clean[j] === ".") {
            breakAt = j + 1; // include the break char on this line
            break;
          }
        }
        if (breakAt > i) end = breakAt;
      }
      let chunk = clean.slice(i, Math.min(end, clean.length));
      // Skip leading whitespace on continuation lines
      if (i > 0 && chunk[0] === " ") chunk = chunk.slice(1);
      lines.push(prefixSgr + chunk + SGR.reset);
      i = end;
    }
    if (!lines.length) lines.push("");
    return lines;
  }

  #inputLine() {
    const prompt = color("> ", SGR.green + SGR.bold);
    const before = this.#inputBuf.slice(0, this.#cursorPos);
    const at = this.#inputBuf[this.#cursorPos] || " ";
    const after = this.#inputBuf.slice(this.#cursorPos + 1);
    const avail = this.#cols - 3;
    const visible = truncate(before + SGR.inverse + at + SGR.reset + after, avail + 10); // SGR codes don't take visual space
    return prompt + visible + CLEAR_LINE;
  }

  #helpLine() {
    let text = "Ctrl+C quit | Enter send | PgUp/PgDn scroll | /help";
    if (this.#busy) text = "Ctrl+C cancel | Waiting for response...";
    return color(truncate(text, this.#cols - 2), SGR.dim) + CLEAR_LINE;
  }

  // ── input handling ────────────────────────────────────────────────────────
  #escBuf = "";  // buffer for in-progress escape sequence
  #confirmInputBuf = ""; // show what user typed during confirmation

  #readStdin() {
    process.stdin.on("data", (data) => {
      if (!this.#running) return;
      try {
        this.#processInput(data);
      } catch {
        // swallow — never let a keystroke crash the TUI
      }
    });
  }

  #processInput(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];

      // If we're mid-escape-sequence, keep collecting
      if (this.#escBuf) {
        this.#escBuf += String.fromCharCode(byte);
        if (this.#isCompleteEscape(this.#escBuf) || this.#escBuf.length >= 32) {
          this.#handleEscape(this.#escBuf);
          this.#escBuf = "";
        }
        continue;
      }

      // Start of escape sequence
      if (byte === 0x1b) {
        this.#escBuf = "\x1b";
        continue;
      }

      this.#handleKey(byte);
    }
  }

  #isCompleteEscape(seq) {
    if (seq === "\x1b") return false;
    if (seq === "\x1b[") return false;

    // CSI mouse reports are variable length: ESC [ < b ; x ; y M/m
    if (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(seq)) return true;

    // CSI final byte range per ECMA-48. Do not treat ESC [ itself as complete.
    if (/^\x1b\[[0-?]*[ -/]*[@-~]$/.test(seq)) return true;

    // SS3 sequences used by some terminals for arrows/function keys.
    if (/^\x1bO[@-~]$/.test(seq)) return true;

    // Plain Alt/meta key sequences: consume the escaped printable key.
    if (/^\x1b[ -~]$/.test(seq)) return true;

    return false;
  }

  #handleEscape(seq) {
    // Mouse wheel/click reports: consume them so they never enter the prompt.
    // Scroll wheel up/down is buttons 64/65 in SGR mouse mode.
    const mouse = seq.match(/^\x1b\[<(\d+);\d+;\d+([mM])$/);
    if (mouse) {
      const button = Number(mouse[1]);
      if (button === 64) {
        this.#scrollOffset += Math.max(1, Math.floor(this.#rows / 2));
        this.#render();
      } else if (button === 65) {
        this.#scrollOffset = Math.max(0, this.#scrollOffset - Math.max(1, Math.floor(this.#rows / 2)));
        this.#render();
      }
      return;
    }

    // Arrow keys: \x1b[A=Up, \x1b[B=Down, \x1b[C=Right, \x1b[D=Left
    if (seq === "\x1b[A") {
      if (this.#history.length && this.#historyIdx < this.#history.length - 1) {
        if (this.#historyIdx === -1) this.#savedInput = this.#inputBuf;
        this.#historyIdx++;
        this.#inputBuf = this.#history[this.#history.length - 1 - this.#historyIdx];
        this.#cursorPos = this.#inputBuf.length;
        this.#render();
      }
      return;
    }
    if (seq === "\x1b[B") {
      if (this.#historyIdx > 0) {
        this.#historyIdx--;
        this.#inputBuf = this.#history[this.#history.length - 1 - this.#historyIdx];
        this.#cursorPos = this.#inputBuf.length;
        this.#render();
      } else if (this.#historyIdx === 0) {
        this.#historyIdx = -1;
        this.#inputBuf = this.#savedInput;
        this.#cursorPos = this.#inputBuf.length;
        this.#render();
      }
      return;
    }
    if (seq === "\x1b[C") {
      if (this.#cursorPos < this.#inputBuf.length) {
        this.#cursorPos++;
        this.#render();
      }
      return;
    }
    if (seq === "\x1b[D") {
      if (this.#cursorPos > 0) {
        this.#cursorPos--;
        this.#render();
      }
      return;
    }
    // Home: \x1b[H or \x1b[1~
    if (seq === "\x1b[H" || seq === "\x1b[1~") {
      this.#cursorPos = 0;
      this.#render();
      return;
    }
    // End: \x1b[F or \x1b[4~
    if (seq === "\x1b[F" || seq === "\x1b[4~") {
      this.#cursorPos = this.#inputBuf.length;
      this.#render();
      return;
    }
    // PgUp: \x1b[5~ — scroll up (see older messages)
    if (seq === "\x1b[5~") {
      this.#scrollOffset += (this.#rows - 5);
      this.#render();
      return;
    }
    // PgDn: \x1b[6~ — scroll down (see newer messages)
    if (seq === "\x1b[6~") {
      this.#scrollOffset = Math.max(0, this.#scrollOffset - (this.#rows - 5));
      this.#render();
      return;
    }
    // Delete: \x1b[3~
    if (seq === "\x1b[3~") {
      if (this.#cursorPos < this.#inputBuf.length) {
        this.#inputBuf = this.#inputBuf.slice(0, this.#cursorPos) + this.#inputBuf.slice(this.#cursorPos + 1);
        this.#render();
      }
      return;
    }
    // SS3 arrow variants.
    if (seq === "\x1bOA") { this.#handleEscape("\x1b[A"); return; }
    if (seq === "\x1bOB") { this.#handleEscape("\x1b[B"); return; }
    if (seq === "\x1bOC") { this.#handleEscape("\x1b[C"); return; }
    if (seq === "\x1bOD") { this.#handleEscape("\x1b[D"); return; }
    // Unknown escape — ignore
  }

  #handleKey(byte) {
    // In confirmation mode, only y/n/Ctrl+C are handled.
    // Echo other typed chars to a buffer so the user can see what they pressed.
    if (this.#confirming) {
      if (byte === 0x03) { // Ctrl+C → deny
        this.#confirmResolve?.(false);
        this.#confirming = false;
        this.#confirmResolve = null;
        this.#confirmInputBuf = "";
        this.#render();
        return;
      }
      if (byte === 0x79 || byte === 0x59) { // y or Y → approve
        this.#confirmResolve?.(true);
        this.#confirming = false;
        this.#confirmResolve = null;
        this.#confirmInputBuf = "";
        this.#render();
        return;
      }
      if (byte === 0x6e || byte === 0x4e) { // n or N → deny
        this.#confirmResolve?.(false);
        this.#confirming = false;
        this.#confirmResolve = null;
        this.#confirmInputBuf = "";
        this.#render();
        return;
      }
      // Echo other keys so user knows they're being ignored
      if (byte === 0x0d) {
        this.#confirmInputBuf += "↵"; // show Enter was pressed but ignored
      } else if (byte === 0x7f || byte === 0x08) {
        this.#confirmInputBuf = this.#confirmInputBuf.slice(0, -1);
      } else if (byte >= 0x20 && byte <= 0x7e) {
        this.#confirmInputBuf += String.fromCharCode(byte);
      }
      if (this.#confirmInputBuf.length > 30) this.#confirmInputBuf = this.#confirmInputBuf.slice(-20);
      this.#render();
      return;
    }

    // Ctrl+C
    if (byte === 0x03) { this.#handleCtrlC(); return; }
    // Ctrl+D on empty input = quit
    if (byte === 0x04 && !this.#inputBuf.length) { this.stop(); return; }

    // Enter
    if (byte === 0x0d) { this.#sendInput(); return; }

    // Backspace (0x7f) or Delete (0x08 = Ctrl+H)
    if (byte === 0x7f || byte === 0x08) {
      if (this.#cursorPos > 0) {
        this.#inputBuf = this.#inputBuf.slice(0, this.#cursorPos - 1) + this.#inputBuf.slice(this.#cursorPos);
        this.#cursorPos--;
        this.#render();
      }
      return;
    }

    // Tab
    if (byte === 0x09) {
      this.#inputBuf = this.#inputBuf.slice(0, this.#cursorPos) + "  " + this.#inputBuf.slice(this.#cursorPos);
      this.#cursorPos += 2;
      this.#render();
      return;
    }

    // Ctrl+A — start of line
    if (byte === 0x01) { this.#cursorPos = 0; this.#render(); return; }
    // Ctrl+E — end of line
    if (byte === 0x05) { this.#cursorPos = this.#inputBuf.length; this.#render(); return; }
    // Ctrl+U — clear line
    if (byte === 0x15) { this.#inputBuf = ""; this.#cursorPos = 0; this.#render(); return; }
    // Ctrl+N — scroll down (newer messages)
    if (byte === 0x0e) { this.#scrollOffset = Math.max(0, this.#scrollOffset - (this.#rows - 6)); this.#render(); return; }
    // Ctrl+P — scroll up (older messages)
    if (byte === 0x10) { this.#scrollOffset += (this.#rows - 6); this.#render(); return; }
    // Ctrl+K — kill to end
    if (byte === 0x0b) { this.#inputBuf = this.#inputBuf.slice(0, this.#cursorPos); this.#render(); return; }
    // Ctrl+W — delete word backward
    if (byte === 0x17) {
      const before = this.#inputBuf.slice(0, this.#cursorPos);
      const after = this.#inputBuf.slice(this.#cursorPos);
      const m = before.match(/(.*\s+)?(\S*)$/);
      this.#inputBuf = (m?.[1] || "") + after;
      this.#cursorPos = (m?.[1] || "").length;
      this.#render();
      return;
    }

    // Printable ASCII
    if (byte >= 0x20 && byte <= 0x7e) {
      const ch = String.fromCharCode(byte);
      this.#inputBuf = this.#inputBuf.slice(0, this.#cursorPos) + ch + this.#inputBuf.slice(this.#cursorPos);
      this.#cursorPos++;
      this.#render();
      return;
    }
  }

  #handleCtrlC() {
    if (this.#confirming) {
      // Deny the pending confirmation
      this.#confirmResolve?.(false);
      this.#confirming = false;
      this.#confirmResolve = null;
      this.#render();
      return;
    }
    if (this.#busy) {
      this.#addMessage("error", "Interrupted.");
      this.stop();
      return;
    }
    this.stop();
  }

  async #sendInput() {
    const text = this.#inputBuf.trim();
    this.#inputBuf = "";
    this.#cursorPos = 0;
    this.#historyIdx = -1;

    if (!text) { this.#render(); return; }

    // Commands
    if (text.startsWith("/")) {
      await this.#handleCommand(text);
      this.#render();
      return;
    }

    // Add to history
    if (!this.#history.length || this.#history.at(-1) !== text) {
      this.#history.push(text);
      if (this.#history.length > 100) this.#history.shift();
    }

    this.#addMessage("user", text);
    this.#render();

    try {
      await this.#session.send(text);
    } catch (err) {
      this.#addMessage("error", `Send failed: ${err.message}`);
      this.#render();
    }
  }

  async #runLocalTool(name, args) {
    try {
      const result = await this.#session.runLocalTool(name, args);
      if (result?.ok && name === "start_shell" && result.result?.pid) {
        this.#addMessage("assistant", `Started local job. PID: ${result.result.pid}\nLog: ${result.result.log_path}`);
      } else if (result?.ok && name === "check_process") {
        const value = result.result || {};
        this.#addMessage("assistant", `PID ${value.pid}: ${value.alive ? "alive" : "not running"}\nLog: ${value.log_path || "(none)"}`);
      }
    } catch (err) {
      this.#addMessage("error", `Local tool failed: ${err.message}`);
    }
  }

  async #handleCommand(cmd) {
    const parts = cmd.slice(1).trim().split(/\s+/);
    const name = parts[0].toLowerCase();

    if (name === "exit" || name === "quit") {
      this.stop();
      return;
    }

    if (name === "help") {
      this.#addMessage("assistant", [
        "Commands:",
        "  /exit, /quit     Quit Claude AI Free",
        "  /help            Show this help",
        "  /clear           Clear message history",
        "  /model           Show current model",
        "  /reconnect, /rc  Reconnect to claude.ai (if stuck)",
        "  /shell CMD       Run a local shell command from /home/tim",
        "  /start_shell CWD LOG -- CMD",
        "                   Start a local background shell job",
        "  /check_process PID LOG",
        "                   Check a local background job and tail its log",
        "  /tool JSON       Run a raw local tool call",
        "",
        "When a CONFIRM bar appears: press Y to approve or N to deny.",
        "Type any message and press Enter to send to Claude.",
        "Claude can use local tools: list files, read/write/edit files,",
        "run shell commands, grep, glob, and more.",
      ].join("\n"));
      return;
    }

    if (name === "clear" || name === "cls") {
      this.#messages = [];
      this.#scrollOffset = 0;
      return;
    }

    if (name === "model") {
      this.#addMessage("assistant", `Current target model: ${this.#session.model}`);
      return;
    }

    if (name === "reconnect" || name === "rc") {
      this.#addMessage("assistant", "Reconnecting to claude.ai...");
      this.#render();
      try {
        await this.#session.close();
      } catch {}
      try {
        await this.#session.connect();
        this.#addMessage("assistant", "Reconnected.");
      } catch (err) {
        this.#addMessage("error", `Reconnect failed: ${err.message}`);
      }
      this.#render();
      return;
    }

    if (name === "shell") {
      const command = cmd.slice(cmd.indexOf(" ") + 1).trim();
      if (!command || command === cmd) {
        this.#addMessage("error", "Usage: /shell CMD");
        return;
      }
      await this.#runLocalTool("shell", { command, cwd: "/home/tim", timeout_ms: 30000 });
      return;
    }

    if (name === "start_shell") {
      const body = cmd.slice(cmd.indexOf(" ") + 1).trim();
      const sep = body.indexOf(" -- ");
      if (!body || sep === -1) {
        this.#addMessage("error", "Usage: /start_shell CWD LOG -- CMD");
        return;
      }
      const [cwd, logPath] = body.slice(0, sep).trim().split(/\s+/);
      const command = body.slice(sep + 4).trim();
      if (!cwd || !logPath || !command) {
        this.#addMessage("error", "Usage: /start_shell CWD LOG -- CMD");
        return;
      }
      await this.#runLocalTool("start_shell", { command, cwd, log_path: logPath });
      return;
    }

    if (name === "check_process") {
      const [, pidText, logPath] = cmd.match(/^\/check_process\s+(\d+)\s+(\S+)/i) || [];
      if (!pidText || !logPath) {
        this.#addMessage("error", "Usage: /check_process PID LOG");
        return;
      }
      await this.#runLocalTool("check_process", { pid: Number(pidText), log_path: logPath, tail_bytes: 20000 });
      return;
    }

    if (name === "tool") {
      const raw = cmd.slice(cmd.indexOf(" ") + 1).trim();
      if (!raw || raw === cmd) {
        this.#addMessage("error", "Usage: /tool {\"name\":\"stat\",\"arguments\":{\"path\":\"/home/tim\"}}");
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const toolName = parsed.name || parsed.tool || parsed.tool_name;
        const toolArgs = parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : { ...parsed };
        delete toolArgs.name;
        delete toolArgs.tool;
        delete toolArgs.tool_name;
        delete toolArgs.arguments;
        if (!toolName) throw new Error("missing name");
        await this.#runLocalTool(toolName, toolArgs);
      } catch (err) {
        this.#addMessage("error", `Invalid /tool JSON: ${err.message}`);
      }
      return;
    }

    this.#addMessage("error", `Unknown command: /${name}. Type /help for available commands.`);
  }
}

// ── main entry ───────────────────────────────────────────────────────────────
let tuiInstance = null;

process.on("uncaughtException", (err) => {
  // Try to restore terminal before crashing
  try { process.stdout.write(DISABLE_MOUSE + SHOW_CURSOR + NORMAL_SCREEN + RESET); } catch {}
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  try { process.stdout.write(DISABLE_MOUSE + SHOW_CURSOR + NORMAL_SCREEN + RESET); } catch {}
  console.error(`Unhandled rejection: ${reason?.message || reason}`);
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  const argValue = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && i < args.length - 1 ? args[i + 1] : fallback;
  };

  const session = new ClaudeFreeSession({
    cdpPort: Number(argValue("--cdp-port", process.env.CLAUDE_CDP_PORT || "9222")),
    targetModel: argValue("--model", process.env.CLAUDE_SONNET_MODEL || "Sonnet 4.6 Max"),
    timeoutMs: Number(argValue("--timeout", process.env.CLAUDE_RESPONSE_TIMEOUT || "120000")),
    chromeBin: argValue("--chrome-bin", process.env.CLAUDE_CHROME_BIN || ""),
  });

  tuiInstance = new ClaudeFreeTUI(session);
  await tuiInstance.start();
}

main().catch((err) => {
  try { process.stdout.write(DISABLE_MOUSE + SHOW_CURSOR + NORMAL_SCREEN + RESET); } catch {}
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
