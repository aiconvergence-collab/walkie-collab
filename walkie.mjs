#!/usr/bin/env node
import { chromium } from "playwright";
import readline from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import { stdin, stdout } from "node:process";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1];
};

const hasFlag = (name) => argv.includes(name);
const HELP = `Usage:
  node walkie.mjs [options]

Options:
  --url <url>           Claude chat URL (default: https://claude.ai/new)
  --model <name>        Model label to prefer in UI (default: Sonnet 4.6 Max)
  --cdp-url <ws>        Connect to an existing Chrome session via CDP (useful for interactive Google login)
  --user-data-dir <dir> Persistent browser profile path
  --browser-path <path>  Override browser executable (default uses playwright managed or system chrome)
  --google-login         Force interactive login flow and keep the browser open until you finish SSO
  --headful              Run with visible browser (default)
  --headless             Run browser headless
  --timeout <ms>         Response timeout (default: 120000)
  --debug                Print parser debug lines
  --help                 Show this help text

Environment:
  CLAUDE_CHAT_URL, CLAUDE_SONNET_MODEL, CLAUDE_USER_DATA_DIR,
  CLAUDE_GOOGLE_LOGIN, CLAUDE_CDP_URL
`;

const isLoginPage = (url) =>
  /claude\.ai\/.*(login|auth|signin)|accounts\.google\.com|oauth2|myaccount\.google\.com|support\.google\.com\/accounts/i.test(
    url || "",
  );

if (hasFlag("--help")) {
  console.log(HELP);
  process.exit(0);
}

const options = {
  chatUrl: argValue("--url", process.env.CLAUDE_CHAT_URL || "https://claude.ai/new"),
  targetModel: argValue(
    "--model",
    process.env.CLAUDE_SONNET_MODEL || "Sonnet 4.6 Max",
  ),
  cdpUrl: argValue("--cdp-url", process.env.CLAUDE_CDP_URL || ""),
  userDataDir:
    argValue(
      "--user-data-dir",
      process.env.CLAUDE_USER_DATA_DIR ||
        path.join(os.homedir(), ".cache", "claude-free-walkie"),
    ) || "",
  browserPath:
    argValue(
      "--browser-path",
      process.env.CLAUDE_CHROME_PATH || process.env.CLAUDE_BROWSER_PATH || "",
    ) || "",
  headless: hasFlag("--headless"),
  timeoutMs: Number(argValue("--timeout", "120000")),
  googleLogin: hasFlag("--google-login") || process.env.CLAUDE_GOOGLE_LOGIN === "1",
  debug: hasFlag("--debug"),
};

if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
  options.timeoutMs = 120000;
}

if (!options.cdpUrl) {
  mkdirSync(options.userDataDir, { recursive: true });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const MODEL_BUTTON_CANDIDATES = [
  '[data-testid="model-selector"]',
  'button:has-text("Model")',
  'button[aria-label*="Model"]',
  '[data-testid*="model"] button',
];

const STOP_BUTTON_CANDIDATES = [
  'button:has-text("Stop generating")',
  'button:has-text("Stop")',
  'button[aria-label*="Stop"]',
];

function dbg(...args) {
  if (!options.debug) {
    return;
  }
  console.log(...args);
}

async function detectInput(page) {
  for (const selector of INPUT_CANDIDATES) {
    const loc = page.locator(selector).first();
    if (await loc.count()) {
      if (await loc.isVisible().catch(() => false)) {
        return loc;
      }
    }
  }
  return null;
}

async function waitForComposer(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const input = await detectInput(page);
    if (input) {
      return input;
    }
    await delay(300);
  }
  throw new Error(
    "Could not locate Claude message composer after waiting. Focus the browser chat input and try again.",
  );
}

async function clickModelIfNeeded(page, modelName) {
  if (!modelName) {
    return;
  }

  // Do not fail the run if model selection UI changes; continue to chat.
  try {
    let trigger = null;
    for (const selector of MODEL_BUTTON_CANDIDATES) {
      const candidate = page.locator(selector).first();
      if (await candidate.count()) {
        trigger = candidate;
        break;
      }
    }

    if (!trigger) {
      return;
    }

    await trigger.click({ timeout: 1200 }).catch(() => {});
    await delay(150);

    const option = page
      .locator(`button:has-text("${modelName}")`)
      .or(page.locator(`text=${modelName}`))
      .first();
    if (await option.count()) {
      await option.click({ timeout: 1200 }).catch(() => {});
    }
  } catch {
    // Ignore UI drift.
  }
}

async function waitForLogin(page) {
  const pauseForUser = async (message) => {
    console.log(message);
    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question("Press Enter after you're logged in: ", () => {
        rl.close();
        resolve();
      });
    });
  };

  const current = page.url();
  if (isLoginPage(current)) {
    const prompt = current.includes("accounts.google.com")
      ? "Google login is required. Complete sign-in in the browser window, then return to claude.ai and press Enter here."
      : "Login is required. Open the browser window and log in to claude.ai, then press Enter here.";
    await pauseForUser(prompt);
    await page.waitForURL(/claude\.ai\/(chat|c\/|$)/, { timeout: 120000 });
    return;
  }
  // If Google SSO opens a separate auth page, wait for any active page to return.
  if (options.googleLogin) {
    const pages = page.context().pages();
    const googlePage = pages.find((candidate) =>
      isLoginPage(candidate.url()),
    );
    if (googlePage) {
      await pauseForUser(
        "Google login flow detected. Complete OAuth in the browser window, then return here and press Enter.",
      );
      await page.waitForURL(/claude\.ai\/(chat|c\/|$)/, { timeout: 120000 });
    }
  }
}

async function parseMessages(page) {
  return page.evaluate(() => {
    const selectors = [
      '[data-message-author]',
      '[data-testid*="message"]',
      '[data-testid*="conversation"]',
      '[data-testid*="turn"]',
      '[role="article"]',
      'main article',
      'main [role="article"]',
      'main [role="listitem"]',
    ];
    const nodeSet = new Set();
    const nodes = [];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        if (nodeSet.has(node)) return;
        nodeSet.add(node);
        const text = (node.textContent || "").trim();
        if (!text || text.length < 2) return;
        const tag = (node.tagName || "").toLowerCase();
        if (tag === "button" || tag === "textarea" || tag === "input") return;
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const authorAttr = (
          node.getAttribute("data-message-author") ||
          node.getAttribute("data-author") ||
          node.getAttribute("role") ||
          ""
        )
          .toLowerCase();
        const testId = (node.getAttribute("data-testid") || "").toLowerCase();
        const id =
          node.getAttribute("data-message-id") ||
          node.getAttribute("id") ||
          `${testId}-${nodes.length}`;
        const className = (node.className || "").toLowerCase();
        const isUser =
          authorAttr.includes("user") ||
          testId.includes("user") ||
          className.includes("user");
        const isAssistant =
          authorAttr.includes("assistant") ||
          testId.includes("assistant") ||
          className.includes("assistant");
        nodes.push({ id, text, isUser, isAssistant });
      });
    }

    const normalized = nodes.map((n, index) => ({ ...n, order: index }));
    normalized.sort((a, b) => a.order - b.order);
    return normalized.filter((entry, index, arr) => {
      if (!entry.text) return false;
      if (index === 0) return true;
      return entry.text !== arr[index - 1]?.text;
    });
  });
}

function pickLatestAssistantText(history, baselineCount = 0, userPrompt = "") {
  if (!history.length) return "";
  const start = Math.min(Math.max(baselineCount, 0), history.length);
  let candidates = history.slice(start).filter((item) => item.text);

  if (userPrompt) {
    const userIndex = [...candidates]
      .map((entry, index) => ({ entry, index: start + index }))
      .findLast(
        (item) => item.entry.isUser || item.entry.text.includes(userPrompt),
      );
    const anchoredStart = (userIndex?.index ?? start - 1) + 1;
    candidates = history.slice(anchoredStart).filter((item) => item.text);
  }

  const markedAssistant = candidates.filter((item) => item.isAssistant);
  const best = (markedAssistant.at(-1) || candidates.at(-1))?.text || "";
  return best || "";
}

function longestCommonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

function extractLatestResponseFromConversationText(conversationText) {
  if (!conversationText) {
    return "";
  }

  const clean = conversationText.replace(/\s+/g, " ").trim();
  const stopTokens = [
    "You said:",
    "New chat",
    "Chats",
    "Projects",
    "Artifacts",
    "Code",
    "Recents",
    "Customize",
    "Free plan",
    "Upgrade",
    "Share",
    "Claude is AI and can make mistakes",
    "Sonnet",
    "Claude finished the response",
    "Goblins",
  ];

  const findBoundary = (text) => {
    let boundary = text.length;
    for (const token of stopTokens) {
      const index = text.indexOf(token);
      if (index >= 0 && index < boundary) {
        boundary = index;
      }
    }
    return boundary;
  };

  const candidates = [
    { marker: "Claude responded:", index: clean.lastIndexOf("Claude responded:") },
    { marker: "assistant:", index: clean.lastIndexOf("assistant:") },
  ];
  const chosen = candidates
    .filter((candidate) => candidate.index !== -1)
    .sort((a, b) => b.index - a.index)[0];

  if (chosen) {
    const responseStart = chosen.index + chosen.marker.length;
    const tail = clean.slice(responseStart).trim();
    if (!tail) {
      return "";
    }
    const stopIndex = findBoundary(tail);
    return tail
      .slice(0, Math.max(0, stopIndex))
      .replace(/[\uE000-\uF8FF]/g, " ")
      .replace(/\s+Share\s*$/i, "")
      .replace(/Claude is AI and can make mistakes\.?/i, "")
      .trim();
  }

  const youSaidIdx = clean.lastIndexOf("You said:");
  const responseFromDialogue = clean.slice(0, youSaidIdx === -1 ? undefined : youSaidIdx);
  const match = responseFromDialogue.match(
    /\bClaude responded:\s*([\s\S]*)/i,
  );
  if (match?.[1]) {
    return match[1].trim();
  }

  return "";
}

async function extractConversationText(page) {
  return page.evaluate(() => {
    const root = document.querySelector("main") || document.body;
    const text = (root?.innerText || "").replace(/\s+/g, " ").trim();
    return text;
  });
}

async function isStreaming(page) {
  for (const selector of STOP_BUTTON_CANDIDATES) {
    const loc = page.locator(selector).first();
    if (await loc.count()) {
      if (await loc.isVisible()) return true;
    }
  }
  return false;
}

async function sendMessage(page, message) {
  const input = await waitForComposer(page);
  if (!input) {
    throw new Error("Could not locate Claude input box.");
  }

  const tag = (await input.evaluate((node) => node.tagName)).toLowerCase();
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click();
  if (tag === "textarea" || tag === "input") {
    await input.fill("");
    await input.fill(message);
  } else {
    await input.evaluate((node, text) => {
      node.focus();
      node.textContent = "";
      node.dispatchEvent(new InputEvent("input", { bubbles: true }));
      node.textContent = text;
      node.dispatchEvent(new InputEvent("input", { bubbles: true }));
      node.dispatchEvent(new InputEvent("change", { bubbles: true }));
    }, message);
  }
  try {
    await input.press("Enter");
  } catch {
    await input.evaluate(() => {
      const e = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true });
      document.activeElement?.dispatchEvent(e);
    });
  }
}

async function connectOverCDPWithRetry(url, retries = 8, delayMs = 600) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await chromium.connectOverCDP(url);
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      if (options.debug) {
        dbg(`CDP connect retry ${attempt}/${retries}: ${error.message}`);
      }
      await delay(delayMs);
    }
  }
  return null;
}

async function streamResponse(page, baselineCount, userMessage, timeoutMs) {
  const baseline = await parseMessages(page);
  const effectiveBaselineCount = Math.max(
    baselineCount,
    baseline.length - 1,
    0,
  );
  const baselineConversation = await extractConversationText(page);
  let lastConversation = baselineConversation;
  let conversationTailText = extractLatestResponseFromConversationText(
    baselineConversation,
  );
  const endAt = Date.now() + timeoutMs;
  let lastText = "";
  let stableTicks = 0;
  let usedConversationFallback = false;

  const snapshot = await parseMessages(page);
  let latest = pickLatestAssistantText(snapshot, effectiveBaselineCount, userMessage);
  if (latest.length) lastText = latest;

  while (Date.now() < endAt) {
    await delay(250);
    const now = await parseMessages(page);
    const current = pickLatestAssistantText(now, effectiveBaselineCount, userMessage);
    dbg("stream snapshot:", {
      baselineCount,
      nowCount: now.length,
      current,
      usedConversationFallback,
    });
    if (current !== lastText) {
      const tail = current.slice(lastText.length);
      if (tail) {
        stdout.write(tail);
      }
      lastText = current;
      usedConversationFallback = false;
      stableTicks = 0;
      continue;
    }

    const conversation = await extractConversationText(page);
    const extracted = extractLatestResponseFromConversationText(conversation);
    const textChanged = extracted !== conversationTailText;

    if (conversation && conversation !== lastConversation) {
      if (extracted) {
        let delta = "";
        if (!conversationTailText) {
          delta = extracted;
        } else if (extracted.startsWith(conversationTailText)) {
          delta = extracted.slice(conversationTailText.length);
        } else {
          const prefix = longestCommonPrefixLength(extracted, conversationTailText);
          delta = extracted.slice(prefix);
        }
        const trimmedDelta = delta.trimStart();
        if (trimmedDelta) {
          stdout.write(trimmedDelta);
          lastText = extracted;
          conversationTailText = extracted;
          usedConversationFallback = true;
          stableTicks = 0;
        }
      }

      lastConversation = conversation;
      if (textChanged || extracted) {
        stableTicks = 0;
      }
      continue;
    }

    stableTicks += 1;
    if (!(await isStreaming(page)) && stableTicks >= 3) {
      break;
    }
    if (stableTicks >= 30) break;
  }

  if (lastText === "") {
    const finalConversation = await extractConversationText(page);
    const finalExtracted = extractLatestResponseFromConversationText(finalConversation);
    const finalSuffix = finalExtracted
      ? finalExtracted.startsWith(conversationTailText || "")
        ? finalExtracted.slice((conversationTailText || "").length)
        : finalExtracted
      : "";
    if (finalSuffix.trim()) {
      stdout.write(finalSuffix.trimStart());
      if (options.debug) {
        dbg("Recovered response from final conversation snapshot:", finalSuffix);
      }
      stdout.write("\n");
      return finalExtracted;
    }

    if (options.debug) {
      const finalMessages = await parseMessages(page);
      dbg("No response captured. Final parsed messages:", finalMessages);
      dbg("Conversation text:", await extractConversationText(page));
    }
    throw new Error("No response text captured from claude.ai.");
  }
  stdout.write("\n");
  return lastText;
}

const cdpHint = (target) => `Cannot attach to Chrome debug endpoint: ${target}.

Start Chrome first, then keep it running:

google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.cache/claude-walkie-cdp

Then open https://claude.ai in that window, complete Google login + security checks, and in a second terminal run:

node walkie.mjs --cdp-url "http://127.0.0.1:9222" --google-login

To verify the endpoint is live:

curl -i http://127.0.0.1:9222/json/version

If this returns nothing, Chrome is not exposing the CDP port yet (or another process is not using that profile/port).
`;

async function main() {
  let browser;
  let context;

  if (options.cdpUrl) {
    try {
      browser = await connectOverCDPWithRetry(options.cdpUrl);
      context = browser.contexts()[0];
      if (!context) {
        context = await browser.newContext();
      }
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
    } catch (error) {
      throw new Error(
        `${error.message}\n\n${cdpHint(options.cdpUrl)}`
      );
    }
  } else {
    const launchOptions = {
      headless: options.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    };
    if (options.browserPath) {
      launchOptions.executablePath = options.browserPath;
    }
    try {
      context = await chromium.launchPersistentContext(options.userDataDir, launchOptions);
    } catch (error) {
      const fallback = "/usr/bin/google-chrome";
      if (
        !options.browserPath &&
        existsSync(fallback) &&
        error.message.includes("Executable doesn't exist")
      ) {
        launchOptions.executablePath = fallback;
        context = await chromium.launchPersistentContext(
          options.userDataDir,
          launchOptions,
        );
      } else {
        throw error;
      }
    }

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = window.chrome || {};
    });
  }

  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  const isExternalContext = Boolean(options.cdpUrl);

  const tryUrls = Array.from(
    new Set([
      options.chatUrl,
      options.chatUrl.replace(/\/+$/, ""),
      "https://claude.ai/new",
      "https://claude.ai/chat",
      "https://claude.ai",
    ]),
  );
  let navigated = false;
  let lastNavError = null;
  for (const target of tryUrls) {
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
      navigated = true;
      break;
    } catch (error) {
      lastNavError = error;
    }
  }
  if (!navigated) {
    throw new Error(
      `Unable to open claude.ai from browser session. Last error: ${lastNavError?.message}`,
    );
  }
  await page.bringToFront().catch(() => {});

  await waitForLogin(page);
  await clickModelIfNeeded(page, options.targetModel);

  console.log(`Claude Walkie (${options.targetModel})`);
  console.log("Type /exit or Ctrl+C to quit.");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = () => new Promise((resolve) => rl.question("you> ", resolve));
  while (true) {
    const text = await ask();
    const trimmed = (text || "").trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.toLowerCase() === "/exit") {
      break;
    }

    try {
      stdout.write("claude> ");
      const baseline = await parseMessages(page);
      const baselineCount = baseline.length;
      await sendMessage(page, trimmed);
      await streamResponse(page, baselineCount, trimmed, options.timeoutMs);
    } catch (error) {
      console.error(`\n${error.message}`);
      continue;
    }
  }

  rl.close();
  if (!isExternalContext && context) {
    await context.close();
  }
  if (!isExternalContext && browser) {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`\nFatal: ${error.message}`);
  process.exit(1);
});
