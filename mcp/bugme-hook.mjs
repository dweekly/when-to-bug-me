#!/usr/bin/env node
// Bug Me's Claude Code hook (docs/STAGE-10.md, 10d): mirrors a session's questions (AskUserQuestion) and
// plan approvals (ExitPlanMode) onto the owner's queue on /me, and their answers when they come. Mirror
// only: the person still answers in the terminal, and nothing this sends can answer for them.
//
// What it sends: the session id, the tool call's id, the project folder's name, and each question's
// text, header and options; on PostToolUse, the answers. Never the transcript, the conversation, the
// plan's text, or the working directory's path. Stop and SessionEnd send only the session id, so Bug
// Me can close whatever that session asked and nobody answered.
//
// It never holds a session up: one overall deadline covers reading the event, finding the key and the
// request; it prints nothing, and it always exits 0, whatever happens.
//
// Configuration, as for mcp/bugme.mjs:
//   BUGME_URL    where Bug Me runs, such as https://bugme.weekly.org (unset: the hook does nothing)
//   the token    from the macOS keychain (service "bugme-live"), or BUGME_TOKEN when set (tests)
//   BUGME_HOOK_DEBUG=1 prints why a delivery failed, on stderr.
// The settings snippet that registers it is in the README ("Mirror your terminal questions").

import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** The whole budget, in ms. Mirrors MIRROR_HOOK_DEADLINE_MS in src/shared/constants.ts (a unit test keeps them equal). */
export const DEADLINE_MS = 2_000;
const TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const str = (v) => (typeof v === "string" ? v : undefined);

/**
 * The request body for one hook event, or null for an event Bug Me doesn't mirror. Built field by
 * field from what's needed, so nothing else in the payload (transcript_path, the plan, the last
 * message) can leak through.
 */
export function hookBody(p) {
  if (!p || typeof p !== "object") return null;
  const session_id = str(p.session_id);
  if (!session_id) return null;
  // Stamped here, as the event happens: async hooks can arrive out of order, and Bug Me puts them back.
  const at = Date.now();
  if (p.hook_event_name === "Stop") return { event: "stop", session_id, at };
  if (p.hook_event_name === "SessionEnd") return { event: "end", session_id, at };
  const event = p.hook_event_name === "PreToolUse" ? "pre" : p.hook_event_name === "PostToolUse" ? "post" : null;
  if (!event || !TOOLS.has(p.tool_name) || !str(p.tool_use_id)) return null;
  const body = { event, session_id, tool_use_id: p.tool_use_id, tool: p.tool_name, project: str(p.cwd) ? basename(p.cwd) : "", at };
  if (p.tool_name === "ExitPlanMode") return body; // the question is fixed; the plan stays in the session
  const input = p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  const response = p.tool_response && typeof p.tool_response === "object" ? p.tool_response : {};
  const questions = Array.isArray(input.questions) ? input.questions : Array.isArray(response.questions) ? response.questions : [];
  body.questions = questions.map((q) => ({
    question: str(q?.question),
    header: str(q?.header),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({ label: str(o?.label), description: str(o?.description) })),
  }));
  if (event === "post") {
    const answers = response.answers ?? input.answers;
    if (answers && typeof answers === "object") body.answers = Object.fromEntries(Object.entries(answers).filter(([, v]) => typeof v === "string"));
  }
  return body;
}

function readStdin() {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(s));
  });
}

function ownerToken(ms) {
  if (process.env.BUGME_TOKEN) return Promise.resolve(process.env.BUGME_TOKEN);
  return new Promise((resolve, reject) =>
    execFile("security", ["find-generic-password", "-s", "bugme-live", "-w"], { timeout: ms, encoding: "utf8" }, (err, out) => (err ? reject(new Error("no owner key in the keychain")) : resolve(out.trim()))),
  );
}

function post(base, key, body, ms) {
  const url = new URL(`${base.replace(/\/+$/, "")}/api/me/mirror`);
  const payload = JSON.stringify(body);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: "POST",
        signal: AbortSignal.timeout(ms),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        res.resume();
        res.on("end", () => ((res.statusCode ?? 500) < 400 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function main() {
  const start = Date.now();
  const left = () => Math.max(1, DEADLINE_MS - (Date.now() - start));
  // The hard stop: whatever is still pending at the deadline (a slow keychain, a hung server) is dropped.
  setTimeout(() => process.exit(0), DEADLINE_MS);
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
  try {
    const raw = await readStdin();
    const body = hookBody(JSON.parse(raw));
    const base = process.env.BUGME_URL;
    if (!body || !base) return;
    const key = await ownerToken(left());
    await post(base, key, body, left());
  } catch (e) {
    if (process.env.BUGME_HOOK_DEBUG) process.stderr.write(`bugme-hook: ${e?.message ?? e}\n`);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
