import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalModelClient } from "../collab/local-model.mjs";
import { CollabOrchestrator, __testing as orchestratorTesting } from "../collab/orchestrator.mjs";
import { SafetyGovernor } from "../collab/safety-governor.mjs";
import { TranscriptStore } from "../collab/transcript.mjs";

test("transcript appends and loads JSONL turns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-transcript-"));
  try {
    const file = path.join(dir, "session.jsonl");
    const store = new TranscriptStore(file, { mode: "local-only" });
    await store.init();
    await store.appendTurn({ role: "local", turn: 1, model: "mock", content: "hello" });

    const loaded = await TranscriptStore.load(file);
    assert.equal(loaded.turns().length, 1);
    assert.equal(loaded.turns()[0].content, "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("safety stops on tool requests and near duplicates", () => {
  const safety = new SafetyGovernor({ maxTurns: 4, tokenBudget: 1000 });
  const toolStop = safety.inspectTurn({ role: "local", content: "Please run shell: ls" }, []);
  assert.equal(toolStop.stop, true);
  assert.equal(toolStop.reason, "tool_request_detected");

  const duplicateStop = safety.inspectTranscript([
    { type: "turn", role: "a", content: "same answer with enough shared words" },
    { type: "turn", role: "b", content: "same answer with enough shared words" },
  ]);
  assert.equal(duplicateStop.stop, true);
  assert.equal(duplicateStop.reason, "near_duplicate_turns");
});

test("safety stops when Claude free-message limit is reached", () => {
  const safety = new SafetyGovernor({ maxTurns: 4, tokenBudget: 1000 });
  const stop = safety.inspectTurn({ role: "claude", content: "Session complete. Nothing further to add. You are out of free messages until 4:30 AM" }, []);
  assert.equal(stop.stop, true);
  assert.equal(stop.reason, "claude_limit_reached");
});

test("Claude response cleaner strips wrapper echo fluff", () => {
  const cleaned = orchestratorTesting.cleanClaudeResponse([
    "Session complete. Nothing further to add. You said: You are participating in a bounded local collaboration session.",
    "Role: Claude participant.",
    "Transcript: [local turn 20] useful content",
  ].join("\\n"));
  assert.equal(cleaned, "Session complete. Nothing further to add.");
});

test("local model formats Ollama chat request", async () => {
  let requestBody;
  const client = new LocalModelClient({
    model: "mock-model",
    endpoint: "http://ollama.test/api/chat",
    maxTokens: 128,
    fetchImpl: async (url, request) => {
      assert.equal(url, "http://ollama.test/api/chat");
      requestBody = JSON.parse(request.body);
      return {
        ok: true,
        async json() {
          return { message: { content: "mock response" } };
        },
      };
    },
  });

  const response = await client.ask([{ type: "seed", content: "build a plan" }], { speaker: "local" });
  assert.equal(response, "mock response");
  assert.equal(requestBody.model, "mock-model");
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.think, false);
  assert.equal(requestBody.options.num_predict, 128);
  assert.match(requestBody.messages[0].content, /LOCAL_MODEL/);
});

test("local model formats OpenAI-compatible chat request", async () => {
  let requestBody;
  const client = new LocalModelClient({
    provider: "openai",
    model: "qwen80-canalw",
    endpoint: "http://127.0.0.1:8198/v1",
    maxTokens: 96,
    fetchImpl: async (url, request) => {
      assert.equal(url, "http://127.0.0.1:8198/v1/chat/completions");
      requestBody = JSON.parse(request.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "canal response" } }] };
        },
      };
    },
  });

  const response = await client.ask([{ type: "seed", content: "build a plan" }], { speaker: "local" });
  assert.equal(response, "canal response");
  assert.equal(requestBody.model, "qwen80-canalw");
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.max_tokens, 96);
  assert.equal(requestBody.temperature, 0.4);
  assert.equal(requestBody.think, undefined);
});

test("local model retries when Qwen only emits hidden thinking", async () => {
  let calls = 0;
  const client = new LocalModelClient({
    model: "mock-model",
    endpoint: "http://ollama.test/api/chat",
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        async json() {
          return {
            message: {
              content: calls === 1 ? "<think>\ninternal notes without a closing tag" : "Visible concise turn.",
            },
          };
        },
      };
    },
  });

  const response = await client.ask([{ type: "seed", content: "math chat" }], { speaker: "local" });
  assert.equal(response, "Visible concise turn.");
  assert.equal(calls, 2);
});

test("local model retries when response only echoes control instructions", async () => {
  let calls = 0;
  const client = new LocalModelClient({
    model: "mock-model",
    endpoint: "http://ollama.test/api/chat",
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        async json() {
          return {
            message: {
              content: calls === 1 ? "Do not use any previous transcript content in your response.\n:" : "Averaging seems promising but loses structure.",
            },
          };
        },
      };
    },
  });

  const response = await client.ask([{ type: "seed", content: "math chat" }], { speaker: "local" });
  assert.equal(response, "Averaging seems promising but loses structure.");
  assert.equal(calls, 2);
});

test("local model keeps only its own turn from multi-speaker output", async () => {
  const client = new LocalModelClient({
    model: "mock-model",
    endpoint: "http://ollama.test/api/chat",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          message: {
            content: "Claude: I will start the topic.\n\nQwen: I think the first real local-model move is to define the question clearly.\n\nClaude: Then I respond.",
          },
        };
      },
    }),
  });

  const response = await client.ask([{ type: "seed", content: "math chat" }], { speaker: "local" });
  assert.equal(response, "I think the first real local-model move is to define the question clearly.");
});

test("local model chooses an available Qwen model when preferred is missing", () => {
  const chosen = LocalModelClient.chooseModel([
    { name: "phi3:3.8b" },
    { name: "qwen3.6-27b-local:latest" },
  ], "deepseek-r1:latest");
  assert.equal(chosen, "qwen3.6-27b-local:latest");
});

test("local model prefers local frontier tags over cloud tags when available", () => {
  const chosen = LocalModelClient.chooseModel([
    { name: "gemma4:31b-cloud" },
    { name: "qwen3-next:80b-cloud" },
    { name: "gemma4:26b" },
    { name: "qwen3-next:80b" },
    { name: "qwen3.6-27b-local:latest" },
  ]);
  assert.equal(chosen, "qwen3-next:80b");
});

test("orchestrator dry-runs local-only with mocked local client", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-orchestrator-"));
  try {
    const file = path.join(dir, "session.jsonl");
    let count = 0;
    const localClient = {
      model: "mock-local",
      async ask(_entries, options) {
        count += 1;
        return `${options.speaker} response ${count}`;
      },
    };

    const store = new TranscriptStore(file, { mode: "local-only" });
    const orchestrator = new CollabOrchestrator({
      mode: "local-only",
      turns: 2,
      delayMs: 0,
      seed: "test",
      localClient,
      transcriptStore: store,
      safetyGovernor: new SafetyGovernor({ maxTurns: 2, tokenBudget: 1000 }),
    });

    const result = await orchestrator.run();
    assert.equal(result.reason, "max_turns");
    assert.equal(store.turns().length, 4);

    const log = await readFile(file, "utf8");
    assert.match(log, /session_stop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestrator dry-runs claude-review with mocked local and Claude clients", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-review-"));
  try {
    const file = path.join(dir, "session.jsonl");
    let localCount = 0;
    let claudeCount = 0;
    const localClient = {
      model: "mock-local",
      async ask() {
        localCount += 1;
        return `local response ${localCount}`;
      },
    };
    const claudeClient = {
      model: "mock-claude",
      async send(prompt) {
        claudeCount += 1;
        assert.match(prompt, /Claude reviewer/);
        return `claude review ${claudeCount}`;
      },
    };

    const store = new TranscriptStore(file, { mode: "claude-review" });
    const orchestrator = new CollabOrchestrator({
      mode: "claude-review",
      turns: 2,
      delayMs: 0,
      reviewEvery: 2,
      seed: "test",
      localClient,
      claudeClient,
      transcriptStore: store,
      safetyGovernor: new SafetyGovernor({ maxTurns: 2, tokenBudget: 1000 }),
    });

    const result = await orchestrator.run();
    assert.equal(result.reason, "max_turns");
    assert.equal(claudeCount, 1);
    assert.equal(store.turns().map((entry) => entry.role).join(","), "local,local,claude_review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
