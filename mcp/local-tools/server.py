#!/usr/bin/env python3
"""
Local Tools MCP Server — exposes shell, file ops, grep, glob to Claude Code.

Stdio JSON-RPC MCP server. No daemon, no network — tools execute directly.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "local-tools", "version": "1.0.0"}

HOME = Path.home()
ALLOWED_ROOTS = [HOME, Path("/tmp"), Path("/var/tmp")]


def _resolve_path(p: str) -> Path:
    """Resolve a user-supplied path, rejecting traversal outside allowed roots."""
    path = Path(p).expanduser().resolve()
    allowed = any(path == r or str(path).startswith(str(r) + os.sep) for r in ALLOWED_ROOTS)
    if not allowed:
        raise ValueError(f"Path outside allowed roots: {path}")
    return path


def _truncate(s: str, n: int = 100000) -> str:
    if len(s) <= n:
        return s
    return s[:n] + f"\n\n[truncated {len(s) - n} chars]"


# ── tool definitions ──────────────────────────────────────────────────────────
TOOL_DEFS = [
    {
        "name": "shell",
        "description": "Run a shell command on the local Linux machine. Returns stdout, stderr, and exit code. Use for quick file ops, git, builds, tests. Do NOT use for long-running servers — use start_shell instead.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The shell command to run."},
                "cwd": {"type": "string", "description": "Working directory (default: /home/tim)."},
                "timeout_ms": {"type": "number", "description": "Timeout in ms (default: 30000, max: 120000)."},
            },
            "required": ["command"],
        },
    },
    {
        "name": "start_shell",
        "description": "Start a long-running background shell job (server, build, model). Returns PID and log path. Use check_process to monitor.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The shell command to run in background."},
                "cwd": {"type": "string", "description": "Working directory."},
                "log_path": {"type": "string", "description": "Path for stdout/stderr log."},
            },
            "required": ["command", "cwd", "log_path"],
        },
    },
    {
        "name": "check_process",
        "description": "Check if a background job is still running and tail its log.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pid": {"type": "number", "description": "Process ID from start_shell."},
                "log_path": {"type": "string", "description": "Log file path from start_shell."},
                "tail_bytes": {"type": "number", "description": "Bytes to read from the end of the log (default: 20000)."},
            },
            "required": ["pid", "log_path"],
        },
    },
    {
        "name": "read_file",
        "description": "Read a file from the local filesystem. Returns content as text.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the file."},
                "max_bytes": {"type": "number", "description": "Max bytes to read (default: 200000, max: 1000000)."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a file with new content. Creates parent directories if needed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path for the file."},
                "content": {"type": "string", "description": "Text content to write."},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": "Replace an exact string in a file. The old_string must match exactly once — include enough surrounding context to make it unique.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the file."},
                "old_string": {"type": "string", "description": "Exact text to find and replace."},
                "new_string": {"type": "string", "description": "Replacement text."},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    {
        "name": "list_dir",
        "description": "List entries in a directory. Returns names and types.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the directory."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "mkdir",
        "description": "Create a directory and any needed parent directories.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to create."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "stat",
        "description": "Get file or directory metadata: size, permissions, timestamps.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "chmod",
        "description": "Change file permissions using octal mode (e.g. 755, 644).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path."},
                "mode": {"type": "string", "description": "Octal mode like 755 or 0644."},
            },
            "required": ["path", "mode"],
        },
    },
    {
        "name": "grep",
        "description": "Search file contents with a regex pattern. Searches recursively if path is a directory. Skips node_modules, .git, and hidden dirs.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern to search for."},
                "path": {"type": "string", "description": "File or directory to search."},
                "max_results": {"type": "number", "description": "Max results (default: 200)."},
            },
            "required": ["pattern", "path"],
        },
    },
    {
        "name": "glob",
        "description": "Find files matching a glob pattern (e.g. **/*.py, src/**/*.ts).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern."},
                "path": {"type": "string", "description": "Root directory to search from."},
            },
            "required": ["pattern", "path"],
        },
    },
]


# ── tool implementations ──────────────────────────────────────────────────────
def _tool_shell(args: dict) -> str:
    cmd = args["command"]
    cwd = str(_resolve_path(args.get("cwd", str(HOME))))
    timeout = min(int(args.get("timeout_ms", 30000)), 120000)

    proc = subprocess.run(
        ["bash", "-lc", cmd],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout / 1000,
        env={**os.environ},
    )
    out = []
    if proc.stdout:
        out.append(_truncate(proc.stdout, 120000))
    if proc.stderr:
        out.append(f"[stderr]\n{_truncate(proc.stderr, 80000)}")
    out.append(f"\n[exit code: {proc.returncode}]")
    return "\n".join(out)


def _tool_start_shell(args: dict) -> str:
    cmd = args["command"]
    cwd = str(_resolve_path(args["cwd"]))
    log_path = str(Path(args["log_path"]).expanduser().resolve())

    log_dir = Path(log_path).parent
    log_dir.mkdir(parents=True, exist_ok=True)

    with open(log_path, "w") as log_fh:
        proc = subprocess.Popen(
            ["bash", "-lc", cmd],
            cwd=cwd,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env={**os.environ},
        )
    return json.dumps({"pid": proc.pid, "command": cmd, "cwd": cwd, "log_path": log_path})


def _tool_check_process(args: dict) -> str:
    pid = int(args["pid"])
    log_path = args.get("log_path", "")
    tail_bytes = min(int(args.get("tail_bytes", 20000)), 200000)

    alive = False
    try:
        os.kill(pid, 0)
        alive = True
    except OSError:
        alive = False

    log_tail = ""
    log_size = 0
    if log_path and os.path.exists(log_path):
        try:
            with open(log_path, "rb") as f:
                f.seek(0, 2)
                log_size = f.tell()
                f.seek(max(0, log_size - tail_bytes))
                log_tail = f.read().decode("utf-8", errors="replace")
        except OSError:
            log_tail = "[could not read log]"

    return json.dumps({
        "pid": pid, "alive": alive, "log_path": log_path,
        "log_size_bytes": log_size,
        "log_tail": _truncate(log_tail, tail_bytes),
    })


def _tool_read_file(args: dict) -> str:
    path = _resolve_path(args["path"])
    max_bytes = min(int(args.get("max_bytes", 200000)), 1000000)
    data = path.read_bytes()
    content = data[:max_bytes].decode("utf-8", errors="replace")
    out = [content]
    if len(data) > max_bytes:
        out.append(f"\n\n[truncated: {len(data)} bytes total, showing first {max_bytes}]")
    return "".join(out)


def _tool_write_file(args: dict) -> str:
    path = _resolve_path(args["path"])
    content = args["content"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return json.dumps({"path": str(path), "bytes_written": len(content.encode("utf-8"))})


def _tool_edit_file(args: dict) -> str:
    path = _resolve_path(args["path"])
    old = args["old_string"]
    new = args["new_string"]
    if not old:
        raise ValueError("old_string must be non-empty")

    data = path.read_text()
    count = data.count(old)
    if count == 0:
        raise ValueError(f"old_string not found in {path}. Must match exactly including whitespace.")
    if count > 1:
        raise ValueError(f"old_string matched {count} times. Must be unique — include more context.")
    updated = data.replace(old, new, 1)
    path.write_text(updated)
    return json.dumps({"path": str(path), "replaced": True, "bytes_before": len(data), "bytes_after": len(updated)})


def _tool_list_dir(args: dict) -> str:
    path = _resolve_path(args["path"])
    entries = []
    for entry in sorted(path.iterdir(), key=lambda e: (not e.is_dir(), e.name)):
        t = "directory" if entry.is_dir() else "symlink" if entry.is_symlink() else "file"
        entries.append({"name": entry.name, "type": t})
    return json.dumps({"path": str(path), "entries": entries[:500], "count": len(entries)})


def _tool_mkdir(args: dict) -> str:
    path = _resolve_path(args["path"])
    path.mkdir(parents=True, exist_ok=True)
    return json.dumps({"path": str(path), "created": True})


def _tool_stat(args: dict) -> str:
    path = _resolve_path(args["path"])
    st = path.stat()
    return json.dumps({
        "path": str(path),
        "type": "directory" if path.is_dir() else "file",
        "size": st.st_size,
        "mode": oct(st.st_mode & 0o777),
        "uid": st.st_uid, "gid": st.st_gid,
        "atime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_atime)),
        "mtime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
    })


def _tool_chmod(args: dict) -> str:
    path = _resolve_path(args["path"])
    mode_str = args["mode"].strip()
    if not re.match(r"^[0-7]{3,4}$", mode_str):
        raise ValueError("mode must be octal, e.g. 755 or 0644")
    mode = int(mode_str, 8)
    path.chmod(mode)
    return json.dumps({"path": str(path), "mode": oct(mode & 0o777)})


def _tool_grep(args: dict) -> str:
    pattern = args["pattern"]
    root = _resolve_path(args["path"])
    max_results = min(int(args.get("max_results", 200)), 1000)
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise ValueError(f"Invalid regex: {e}")

    results = []
    skip_dirs = {".git", "node_modules", "__pycache__", ".cache", ".venv", "venv"}

    def _search_file(fp: Path) -> None:
        if len(results) >= max_results:
            return
        try:
            for i, line in enumerate(fp.read_text(errors="replace").splitlines(), 1):
                if regex.search(line):
                    results.append({"path": str(fp), "line": i, "content": line[:500]})
                    if len(results) >= max_results:
                        return
        except (OSError, UnicodeDecodeError):
            pass

    if root.is_file():
        _search_file(root)
    else:
        stack = [root]
        while stack and len(results) < max_results:
            d = stack.pop()
            try:
                for entry in d.iterdir():
                    if entry.name.startswith(".") or entry.name in skip_dirs:
                        continue
                    if entry.is_dir():
                        stack.append(entry)
                    elif entry.is_file():
                        _search_file(entry)
            except OSError:
                pass

    return json.dumps({"pattern": pattern, "results": results, "count": len(results)})


def _tool_glob(args: dict) -> str:
    pattern = args["pattern"]
    root = _resolve_path(args["path"])
    matches = []
    for p in root.rglob(pattern):
        if matches and len(matches) >= 100:
            break
        if ".git" in p.parts or "node_modules" in p.parts:
            continue
        matches.append(str(p.relative_to(root)))
    return json.dumps({"pattern": pattern, "root": str(root), "matches": matches, "count": len(matches)})


TOOL_IMPLS = {
    "shell": _tool_shell,
    "start_shell": _tool_start_shell,
    "check_process": _tool_check_process,
    "read_file": _tool_read_file,
    "write_file": _tool_write_file,
    "edit_file": _tool_edit_file,
    "list_dir": _tool_list_dir,
    "mkdir": _tool_mkdir,
    "stat": _tool_stat,
    "chmod": _tool_chmod,
    "grep": _tool_grep,
    "glob": _tool_glob,
}


# ── JSON-RPC dispatcher ──────────────────────────────────────────────────────
def _write_response(resp: dict) -> None:
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()


def handle_request(req: dict) -> None:
    method = req.get("method", "")
    req_id = req.get("id")
    params = req.get("params", {})

    if method == "initialize":
        _write_response({"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
        }})
        return

    if method == "notifications/initialized":
        return

    if method == "tools/list":
        tools = [{"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]} for t in TOOL_DEFS]
        _write_response({"jsonrpc": "2.0", "id": req_id, "result": {"tools": tools}})
        return

    if method == "tools/call":
        name = params.get("name", "")
        args = params.get("arguments", {})
        if name not in TOOL_IMPLS:
            _write_response({"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text", "text": f"Unknown tool: {name}"}],
                "isError": True,
            }})
            return
        try:
            result_text = TOOL_IMPLS[name](dict(args))
            _write_response({"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text", "text": result_text}],
            }})
        except Exception as exc:
            _write_response({"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text", "text": f"Error: {exc}"}],
                "isError": True,
            }})
        return

    if method == "ping":
        _write_response({"jsonrpc": "2.0", "id": req_id, "result": {}})
        return

    if req_id is not None:
        _write_response({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method not found: {method}"}})


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        handle_request(req)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
