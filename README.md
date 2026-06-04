# Walkie Collab

Bounded terminal collaboration between a local model endpoint and a Claude.ai
browser session. The collab mode is designed as a visible terminal room: a
selected local model sends a turn, Claude replies through the user's existing
Claude.ai web session, and the transcript is written locally.

This project does not provide unlimited Claude access and does not bypass
account limits. It drives the user's own logged-in Claude.ai web UI through a
local Chrome/Chromium CDP session. Behavior depends on the user's account,
available model, rate limits, and the current Claude.ai UI.

## Collab Mode

Install dependencies:

```bash
npm install
```

Start a generic collab terminal:

```bash
npm run collab -- --mode claude-live --local-model your-model:tag --turns 2000 --duration-minutes 120 --delay-ms 5000 --seed "Subject: your topic. Chat continuously for two hours. No tools."
```

Or install desktop launchers:

```bash
npm run install-desktop
```

Then open **Walkie Collab** from the app menu or desktop. It prompts for a
local model, prompts for a subject, and opens a terminal where that model and
Claude chat turn by turn.

Safety defaults:

- finite turn and duration caps
- local tools disabled in collab mode
- JSONL transcript logging under `.cache/collab/`
- stop guards for obvious tool requests, repetition, and token budget

Local model support works with Ollama by default. Advanced users can also point
Walkie Collab at any explicitly configured OpenAI-compatible local chat endpoint.

For Ollama, use any model visible in:

```bash
ollama list
```

Set the model for the desktop launcher with:

```bash
WALKIE_COLLAB_LOCAL_MODEL="your-model:tag" scripts/launch-walkie-collab.sh
```

For a custom local chat endpoint, pass the provider and endpoint explicitly:

```bash
WALKIE_COLLAB_LOCAL_PROVIDER=openai \
WALKIE_COLLAB_LOCAL_URL=http://127.0.0.1:PORT/v1/chat/completions \
WALKIE_COLLAB_LOCAL_MODEL=your-model-name \
scripts/launch-walkie-collab.sh
```

The selector also accepts a portable encoded form:

```bash
openai|http://127.0.0.1:PORT/v1/chat/completions|your-model-name
```

Recommended local and cloud model tags that work through Ollama's model registry:

```bash
ollama pull qwen3-next:80b
ollama pull gemma4:26b
ollama pull qwen3-next:80b-cloud
ollama pull gemma4:31b-cloud
```

Or plug in your own selector. The selector can be any executable; it should
print exactly one model name/tag or `provider|endpoint|model` selection to
stdout:

```bash
WALKIE_COLLAB_MODEL_SELECTOR="./scripts/select-local-model.sh" scripts/launch-walkie-collab.sh
npm run collab -- --mode claude-live --local-model-selector ./scripts/select-local-model.sh --turns 2000 --duration-minutes 120 --seed "Subject: your topic. No tools."
```

## Legacy Claude Website Chat

Desktop chat wrapper backed by the free claude.ai web tier. One desktop icon, one
chat window — no API key, no bash prompt, no Claude Code subscription.

## Architecture

```
Desktop icon
  └─ scripts/launch-claude-desktop-ui.sh   (node resolver + exec)
       └─ chat-app.mjs                      (HTTP server + Playwright/Chrome)
            ├─ http://127.0.0.1:18765/      (chat UI, served as HTML)
            ├─ /events                      (SSE stream for real-time updates)
            ├─ /send                        (POST user messages)
            ├─ /status                      (GET health + state)
            └─ /restart                     (POST graceful restart)

  Chrome (CDP on 127.0.0.1:9222)
    └─ claude.ai  (logged-in free tier session)
```

The Node server drives claude.ai through Playwright-over-CDP. User messages typed
into the local HTML UI are forwarded into the claude.ai web composer. Claude's
responses are streamed back via SSE. Tool calls embedded in Claude's response are
intercepted, executed locally, and results are fed back into the conversation.

## Prerequisites

- Node.js (any maintained LTS)
- Google Chrome or Chromium
- A logged-in claude.ai free-tier session in Chrome

## Install

```bash
cd /home/tim/claude-free-claude-walkie
npm install
bash scripts/install-desktop-icon.sh
```

This creates:

- `~/.local/share/applications/claude-website-chat.desktop` (app menu)
- `~/Desktop/claude-website-chat.desktop` (desktop icon)

Both point to `scripts/launch-claude-desktop-ui.sh`.

## Usage

Click the **Claude Website Chat** desktop icon.

On first launch Chrome opens to claude.ai. Log in and complete any security
verification. The local chat window connects automatically once the composer is
detected. Subsequent launches reuse the existing Chrome profile.

### Restart

If the chat window is unresponsive or the status is stuck:

```bash
bash /home/tim/claude-free-claude-walkie/scripts/restart.sh
```

This kills the old process, frees the port, and relaunches. The desktop icon also
handles restart: if the old server is dead, clicking the icon starts a fresh one.

### Local Tools

The wrapper gives Claude access to your local filesystem. Available tools:

| Tool | Arguments | Description |
|------|-----------|-------------|
| `list_dir` | `{"path":"/path"}` | List directory entries (max 500) |
| `read_file` | `{"path":"/path","max_bytes":200000}` | Read file contents |
| `write_file` | `{"path":"/path","content":"text"}` | Write a file (creates parents) |
| `mkdir` | `{"path":"/path"}` | Create directory (recursive) |
| `stat` | `{"path":"/path"}` | File metadata (size, mode, timestamps) |
| `chmod` | `{"path":"/path","mode":"755"}` | Change file permissions (octal) |
| `shell` | `{"command":"...","cwd":"/home/tim","timeout_ms":30000}` | Run a shell command |

Tools run as user `tim` with the same permissions you have. Tool calls and results
are displayed in the chat window with dashed borders.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CHAT_APP_PORT` | `18765` | HTTP server port |
| `CLAUDE_CDP_PORT` | `9222` | Chrome debug protocol port |
| `CLAUDE_CDP_URL` | `http://127.0.0.1:9222` | CDP endpoint |
| `CLAUDE_CDP_PROFILE` | `~/.cache/claude-walkie-cdp` | Chrome user data directory |
| `CLAUDE_CHROME_BIN` | (auto-detect) | Override Chrome executable path |
| `CLAUDE_CHAT_URL` | `https://claude.ai/new` | Claude chat URL |
| `CLAUDE_SONNET_MODEL` | `Sonnet 4.6 Max` | Model label to select (best effort) |
| `CLAUDE_RESPONSE_TIMEOUT` | `120000` | Max wait for a response (ms) |

## Logs

All server events are logged to:

```
~/.cache/claude-website-chat.log
```

The log auto-rotates at 2 MB (keeps ~60% of content). Check it when
troubleshooting:

```bash
tail -f ~/.cache/claude-website-chat.log
```

## Troubleshooting

**"Port 18765 is held by a stale process"**
The previous server crashed but the OS hasn't released the port yet. Run:
```bash
bash /home/tim/claude-free-claude-walkie/scripts/restart.sh
```

**Status stuck on "Waiting for Chrome"**
Chrome may need login or a security challenge. Switch to the Chrome window,
complete it, and the chat window connects automatically.

**"No response text captured"**
The claude.ai page structure may have changed. Check the log for details.
Try restarting. If persistent, the DOM selectors in `parseMessages` may need
updating for the current claude.ai UI.

**Model selection shows wrong model**
Model selection is best effort — the claude.ai model picker UI changes
frequently. Set `CLAUDE_SONNET_MODEL` to match a visible label, or select
the model manually in the Chrome window.

**Chrome opens a regular window instead of an app window**
The `--app=` flag is used but some Chrome builds ignore it. The chat UI is
still accessible at `http://127.0.0.1:18765` in any browser.

**Port 9222 already in use**
Another Chrome instance is using the debug port. Either close it, or set
`CLAUDE_CDP_PORT` to a different port (e.g. `9223`) and restart.

## Files

```
claude-free-claude-walkie/
  chat-app.mjs              Main server + UI
  walkie.mjs                CLI (terminal) variant — not used by desktop launcher
  package.json
  scripts/
    launch-claude-desktop-ui.sh   Entry point for desktop icon
    launch-claude-desktop.sh      Older launcher (CLI variant)
    install-desktop-icon.sh       Installs .desktop files
    restart.sh                    Kill + relaunch
  assets/
    claude-walkie.svg             App icon
```
