import { formatTranscript } from "./transcript.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function claudeBasePrompt({ role, transcriptEntries, seed }) {
  const transcript = formatTranscript(transcriptEntries, { maxChars: 12000 });
  return [
    "You are participating in a bounded local collaboration session.",
    `Role: ${role}.`,
    "The local wrapper is routing messages and enforcing safety limits.",
    "Do not request local tools during this collab mode unless the user explicitly asks for tool use.",
    "Use plain text math notation, not LaTeX.",
    seed ? `User seed prompt:\n${seed}` : "",
    "Transcript:",
    transcript,
    "",
    "Respond as Claude in one concise turn.",
  ]
    .filter(Boolean)
    .join("\n");
}

function cleanClaudeResponse(text) {
  let value = String(text || "");
  value = value.replace(/\bYou've used \d+% of your session limit\b\.?/gi, "");
  value = value.replace(/\bYou are out of free messages until\b[\s\S]*$/i, "You are out of free messages.");
  value = value.replace(/\bYou said:\s*You are participating in a bounded local collaboration session[\s\S]*$/i, "");
  const claudeMatch = /^\s*\[Claude\]\s*([\s\S]*?)(?=\n\s*\[(?:local|qwen|claude|seed)[^\]]*\]|\n\s*(?:Respond as|Write only|Transcript:|User seed prompt:)|$)/i.exec(value);
  if (claudeMatch) value = claudeMatch[1];
  value = value.replace(/^\s*\[Claude\]\s*/i, "");
  value = value.replace(/^\s*Claude\s*:?\s*/i, "");
  value = value
    .split("\n")
    .filter((line) => !/^\s*(respond as|write only|transcript:|user seed prompt:|do not continue|no previous messages)\b/i.test(line))
    .join("\n");
  value = value.replace(/\n\s*(respond as|write only|transcript|user seed prompt)\s*[:\w\s]*[\s\S]*$/i, "");
  value = value.replace(/\n\s*\[(?:local|qwen|claude|seed)[^\]]*\][\s\S]*$/i, "");
  value = value.trim();
  return value || String(text || "").trim();
}

export const __testing = { cleanClaudeResponse };

export class CollabOrchestrator {
  constructor(options = {}) {
    this.mode = options.mode || "local-only";
    this.turns = Number(options.turns || 20);
    this.delayMs = Number(options.delayMs ?? 5000);
    this.durationMs = Number(options.durationMs || 0);
    this.reviewEvery = Number(options.reviewEvery || 4);
    this.seed = options.seed || "Discuss the topic and converge on concise next steps.";
    this.local = options.localClient;
    this.claude = options.claudeClient || null;
    this.transcript = options.transcriptStore;
    this.safety = options.safetyGovernor;
    this.onEvent = options.onEvent || (() => {});
    this.onTurn = options.onTurn || (() => {});

    if (!this.local) throw new Error("CollabOrchestrator requires a localClient.");
    if (!this.transcript) throw new Error("CollabOrchestrator requires a transcriptStore.");
    if (!this.safety) throw new Error("CollabOrchestrator requires a safetyGovernor.");
    if ((this.mode === "claude-review" || this.mode === "claude-live") && !this.claude) {
      throw new Error(`${this.mode} requires a claudeClient.`);
    }
    if (!Number.isInteger(this.reviewEvery) || this.reviewEvery <= 0) {
      throw new Error("--review-every must be a positive integer.");
    }
    if (!Number.isFinite(this.durationMs) || this.durationMs < 0) {
      throw new Error("--duration-minutes must be zero or a positive number.");
    }
  }

  async run() {
    await this.transcript.init();
    await this.transcript.append({
      type: "seed",
      role: "user",
      turn: 0,
      model: "human",
      content: this.seed,
      metadata: { mode: this.mode },
    });

    this.onEvent({ type: "start", mode: this.mode, transcript: this.transcript.path });

    let stop = { stop: false };
    let completedTurns = 0;
    const deadline = this.durationMs > 0 ? Date.now() + this.durationMs : 0;
    for (let turn = 1; turn <= this.turns; turn++) {
      if (deadline && Date.now() >= deadline) {
        stop = { stop: true, reason: "duration_elapsed" };
        break;
      }

      completedTurns = turn;
      stop = await this.#localTurn({ turn, role: "local" });
      if (stop.stop) break;

      if (this.mode === "local-only") {
        stop = await this.#localTurn({ turn, role: "local_peer" });
        if (stop.stop) break;
      }

      if (this.mode === "claude-review" && turn % this.reviewEvery === 0) {
        stop = await this.#claudeTurn({
          turn,
          role: "claude_review",
          promptRole: "Claude reviewer",
        });
        if (stop.stop) break;
      }

      if (this.mode === "claude-live") {
        stop = await this.#claudeTurn({
          turn,
          role: "claude",
          promptRole: "Claude participant",
        });
        if (stop.stop) break;
      }

      stop = this.safety.inspectTranscript(this.transcript.entries);
      if (stop.stop) break;
      if (turn < this.turns && this.delayMs > 0) {
        const remaining = deadline ? Math.max(0, deadline - Date.now()) : this.delayMs;
        await delay(Math.min(this.delayMs, remaining));
      }
    }

    const stopReason = stop.stop ? stop.reason : "max_turns";
    await this.transcript.appendStop(stopReason, {
      completedTurns,
      detail: stop.detail || "",
      speaker: stop.speaker || "",
      mode: this.mode,
    });
    this.onEvent({ type: "stop", reason: stopReason, detail: stop.detail || "", speaker: stop.speaker || "" });
    return { reason: stopReason, completedTurns, transcriptPath: this.transcript.path };
  }

  async #localTurn({ turn, role }) {
    this.onEvent({ type: "asking", role, turn });
    const content = await this.local.ask(this.transcript.entries, {
      speaker: role,
      seed: this.seed,
    });
    const entry = await this.transcript.appendTurn({
      role,
      turn,
      model: this.local.model,
      content,
      metadata: { mode: this.mode },
    });
    this.onTurn(entry);
    return this.safety.inspectTurn(entry, this.transcript.entries);
  }

  async #claudeTurn({ turn, role, promptRole }) {
    this.onEvent({ type: "asking", role, turn });
    const prompt = claudeBasePrompt({
      role: promptRole,
      transcriptEntries: this.transcript.entries,
      seed: this.seed,
    });
    const content = cleanClaudeResponse(await this.claude.send(prompt));
    const entry = await this.transcript.appendTurn({
      role,
      turn,
      model: this.claude.model || "claude",
      content,
      metadata: { mode: this.mode },
    });
    this.onTurn(entry);
    return this.safety.inspectTurn(entry, this.transcript.entries);
  }
}

export default CollabOrchestrator;
