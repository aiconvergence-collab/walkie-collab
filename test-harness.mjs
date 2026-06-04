#!/usr/bin/env node
// Quick test harness — uses ClaudeFreeSession directly, no TUI.
import { ClaudeFreeSession } from "./claude-free-api.mjs";

const session = new ClaudeFreeSession({
  requireConfirmation: false, // auto-deny dangerous ops for safe testing
});

session.on("state-change", ({ state, detail }) => {
  console.error(`[${state}] ${detail}`);
});

session.on("delta", ({ text }) => {
  process.stdout.write(text);
});

session.on("tool-call", ({ name, arguments: args }) => {
  console.error(`\n[TOOL: ${name}] ${JSON.stringify(args).slice(0, 200)}`);
});

session.on("tool-result", ({ name, ok }) => {
  console.error(`[RESULT: ${name}] ${ok ? "ok" : "FAILED"}`);
});

session.on("error", ({ message }) => {
  console.error(`\n[ERROR] ${message}`);
});

const prompt = process.argv[2] || "hello, what model are you running?";

console.error(`\n>>> Sending: ${prompt.slice(0, 80)}...\n`);

try {
  await session.connect();
  const response = await session.send(prompt);
  console.log("\n\n=== DONE ===");
  console.log(response.slice(0, 2000));
} catch (err) {
  console.error(`FATAL: ${err.message}`);
} finally {
  await session.close();
  process.exit(0);
}
