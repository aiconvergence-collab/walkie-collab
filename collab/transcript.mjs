import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function makeSessionId() {
  return `collab-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export class TranscriptStore {
  constructor(filePath, metadata = {}) {
    if (!filePath) throw new Error("Transcript path is required.");
    this.path = path.resolve(filePath);
    this.sessionId = metadata.sessionId || makeSessionId();
    this.metadata = { ...metadata, sessionId: this.sessionId };
    this.entries = [];
  }

  async init() {
    await mkdir(path.dirname(this.path), { recursive: true });
    await writeFile(this.path, "", { flag: "a" });
    if (!this.entries.length) {
      await this.append({
        type: "session_start",
        role: "system",
        content: "collab session started",
        metadata: this.metadata,
      });
    }
  }

  async append(entry) {
    const record = {
      type: entry.type || "turn",
      sessionId: this.sessionId,
      timestamp: entry.timestamp || new Date().toISOString(),
      ...entry,
    };
    this.entries.push(record);
    await writeFile(this.path, `${JSON.stringify(record)}\n`, { flag: "a" });
    return record;
  }

  async appendTurn({ role, turn, model, content, metadata = {} }) {
    if (!role) throw new Error("Transcript turn role is required.");
    return this.append({
      type: "turn",
      role,
      turn,
      model,
      content: String(content ?? ""),
      metadata,
    });
  }

  async appendStop(stopReason, metadata = {}) {
    return this.append({
      type: "session_stop",
      role: "system",
      content: String(stopReason || "stopped"),
      stopReason: String(stopReason || "stopped"),
      metadata,
    });
  }

  turns() {
    return this.entries.filter((entry) => entry.type === "turn");
  }

  static async load(filePath) {
    const absolute = path.resolve(filePath);
    const text = await readFile(absolute, "utf8");
    const entries = text
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid transcript JSONL at line ${index + 1}: ${error.message}`);
        }
      });
    const first = entries.find((entry) => entry.sessionId);
    const store = new TranscriptStore(absolute, first?.metadata || {});
    store.sessionId = first?.sessionId || store.sessionId;
    store.entries = entries;
    return store;
  }
}

export function formatTranscript(entries, { maxChars = 16000 } = {}) {
  const turns = entries.filter((entry) => entry.type === "turn" || entry.type === "seed");
  const lines = turns.map((entry) => {
    const label = entry.type === "seed" ? "seed" : `${entry.role} turn ${entry.turn}`;
    return `[${label}]\n${String(entry.content ?? "").trim()}`;
  });
  const text = lines.join("\n\n");
  if (text.length <= maxChars) return text || "[empty transcript]";
  return `[transcript truncated]\n${text.slice(text.length - maxChars)}`;
}

export default TranscriptStore;
