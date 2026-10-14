#!/usr/bin/env node
// A stand-in `claude` for the runner's tests (docs/STAGE-9.md). It records every call's argv (and stdin
// for -p) to $FAKE_CLAUDE_STATE, a JSON file, and answers the few commands the runner uses:
//   mcp list              one line per server in the state's `mcp` map ({cwd: [[name, status]]} or default)
//   agents --json --all   the sessions it has started
//   --bg …                starts a "session": prints the line `claude --bg` prints
//   -p …                  echoes {structured_output: {prompt_chars}}; FAKE_CLAUDE_SLEEP_MS delays it
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_CLAUDE_STATE;
const state = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
state.calls ??= [];
state.sessions ??= [];
const args = process.argv.slice(2);
const save = () => file && writeFileSync(file, JSON.stringify(state));

if (args[0] === "mcp" && args[1] === "list") {
  state.calls.push({ args, cwd: process.cwd() });
  save();
  const servers = state.mcp?.[process.cwd()] ?? state.mcp?.default ?? [["bugme", "connected"]];
  const word = { connected: "✔ Connected", "needs authentication": "! Needs authentication", failed: "✗ Failed to connect" };
  process.stdout.write(`Checking MCP server health…\n\n${servers.map(([n, s]) => `${n}: node x.mjs - ${word[s] ?? s}`).join("\n")}\n`);
} else if (args[0] === "agents") {
  state.calls.push({ args, cwd: process.cwd() });
  save();
  process.stdout.write(JSON.stringify(state.sessions));
} else if (args[0] === "--bg") {
  const name = args[args.indexOf("-n") + 1];
  const id = Math.random().toString(16).slice(2, 10);
  state.calls.push({ args, cwd: process.cwd() });
  if (state.failLaunch) {
    save();
    process.stderr.write("Workspace not trusted.\n");
    process.exit(1);
  }
  state.sessions.push({ id, name, cwd: process.cwd(), kind: "background", status: "busy", state: "working" });
  save();
  process.stdout.write(`Starting background service…\nbackgrounded · ${id} · ${name}\n`);
} else if (args[0] === "-p") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    state.calls.push({ args, cwd: process.cwd(), stdin: input });
    save();
    setTimeout(() => process.stdout.write(JSON.stringify({ is_error: false, structured_output: { prompt_chars: input.length } })), Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0));
  });
} else {
  process.stderr.write(`fake claude: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
