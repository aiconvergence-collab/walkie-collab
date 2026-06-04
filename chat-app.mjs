#!/usr/bin/env node
// Disabled compatibility entrypoint.
//
// The old browser-hosted GUI carried its own tool executor and confirmation
// endpoint. That duplicated the hardened CLI backend and widened the local
// attack surface. Keep this file as a safe stub so stale launchers fail closed.

console.error("Claude Website Chat is disabled for security.");
console.error("Use the hardened Claude Walkie console launcher instead:");
console.error("  /home/tim/claude-free-claude-walkie/scripts/launch-claude-cli.sh");
process.exit(2);
