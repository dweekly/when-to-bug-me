// Onboarding on your own history (docs/STAGE-10.md, 10b): turn rows extracted from your Claude Code
// transcripts (one JSON object per question, as the research repo's extractor writes them) into
// onboarding's history, and send them to the runner, which drafts your "how to work with me" note with
// your Claude login. Nothing it reads or sends is written to this repo, a log, the cache or the recordings.
//
//   npm run onboard -- --allow <allow-list.json> <rows.jsonl> [more.jsonl …]
//
// Only projects on the allow list are read (a JSON file {"allow": [<transcript folder names>]}: the same
// list that decides which questions may reach a model at all). Without it, nothing is sent. A deny file
// (private/onboard-deny.txt, gitignored: one project marker or "machine session" per line) excludes more.
// It talks only to the runner on this machine, with the runner's own key; there is no hosted fallback.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_ONBOARD_HISTORY, ONBOARD_MAX_BODY_BYTES, RUNNER_PORT } from "../src/shared/constants";
import type { HistoryItem } from "../src/shared/onboarding";

/** One row as the extractor writes it (only the fields used here). */
export interface ExtractRow {
  machine?: string;
  project?: string;
  session?: string;
  call_id?: string;
  q_index?: number;
  ts?: string;
  call_status?: string;
  question?: string;
  multi_select?: boolean;
  options?: { label?: string; description?: string }[];
  rec_idx?: number | null;
  rec_source?: string | null;
  answer?: string | null;
  answer_kind?: string;
  chosen_idx?: number | null;
  free_text?: string | null;
  note?: string | null;
}

const KEYS = ["A", "B", "C", "D", "E", "F"];

/** "-Users-someone-dev-app" → "app": the last part of the transcript-folder name, for a short label. */
export function projectLabel(folder: string): string {
  const parts = folder.split("-").filter(Boolean);
  const dev = parts.lastIndexOf("dev");
  return (dev >= 0 ? parts.slice(dev + 1) : parts.slice(-1)).join("-").toLowerCase().slice(0, 40) || "other";
}

/** Allowed: on the allow list (a project or a sibling worktree of one), and not denied by marker or session. */
export function allowed(row: ExtractRow, allow: string[], denyMarkers: string[], denySessions: Set<string>): boolean {
  const proj = (row.project ?? "").toLowerCase();
  if (!proj || denyMarkers.some((m) => proj.includes(m))) return false;
  if (denySessions.has(`${row.machine ?? ""} ${row.session ?? ""}`)) return false;
  return allow.some((a) => proj === a.toLowerCase() || proj.startsWith(`${a.toLowerCase()}-`));
}

/**
 * Rows → history: answered questions only, each call-and-question once, newest first, at most `max`.
 * The answer is an option key when one was picked; typed and multi-select answers keep their words.
 */
export function toHistory(rows: ExtractRow[], now: Date, max = MAX_ONBOARD_HISTORY): HistoryItem[] {
  const seen = new Set<string>();
  const answered = rows
    .filter((r) => r.call_status === "answered" && r.answer_kind && r.answer_kind !== "unanswered" && r.question && r.ts)
    .filter((r) => {
      const k = `${r.call_id}:${r.q_index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => Date.parse(b.ts!) - Date.parse(a.ts!))
    .slice(0, max);
  return answered.map((r) => {
    const options = (r.options ?? []).slice(0, KEYS.length).map((o, i) => ({ key: KEYS.at(i)!, label: (o.label ?? "").slice(0, 200) })).filter((o) => o.label);
    const picked = typeof r.chosen_idx === "number" && r.chosen_idx < options.length ? options.at(r.chosen_idx)!.key : null;
    const typed = picked ? undefined : (r.free_text ?? r.answer ?? "").slice(0, 600) || undefined;
    const rec = r.rec_source === "explicit" && typeof r.rec_idx === "number" && r.rec_idx < options.length ? options.at(r.rec_idx)!.key : undefined;
    return {
      id: `x${createHash("sha256").update(`${r.call_id}:${r.q_index}`).digest("hex").slice(0, 10)}`,
      project: projectLabel(r.project ?? ""),
      days_ago: Math.max(0, Math.round((now.getTime() - Date.parse(r.ts!)) / 86_400_000)),
      question: (r.question ?? "").slice(0, 600),
      options,
      ...(rec ? { recommended: rec } : {}),
      answer: picked,
      ...(typed ? { typed } : {}),
      ...(r.note ? { reason: r.note.slice(0, 600) } : {}),
    };
  });
}

/** The newest items that fit the endpoint's byte limit, measured as the request is sent. */
export function fitBytes(history: HistoryItem[], max = ONBOARD_MAX_BODY_BYTES): HistoryItem[] {
  const out = [...history];
  while (out.length > 1 && Buffer.byteLength(JSON.stringify({ history: out })) > max) out.pop();
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--allow");
  const eligibility = at >= 0 ? args.at(at + 1) : undefined;
  const files = args.filter((a, i) => !a.startsWith("--") && i !== at + 1);
  if (!eligibility || !files.length) throw new Error("usage: npm run onboard -- --allow <allow-list.json> <rows.jsonl> [more.jsonl …]");
  if (!existsSync(eligibility)) throw new Error(`no allow list at ${eligibility}: nothing is sent without it`);
  const allow = (JSON.parse(readFileSync(eligibility, "utf8")) as { allow?: string[] }).allow ?? [];
  const denyFile = resolve("private/onboard-deny.txt");
  const deny = existsSync(denyFile) ? readFileSync(denyFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  if (!existsSync(denyFile)) console.warn(`note: no ${denyFile}; only the allow list applies`);
  const denySessions = new Set(deny.filter((l) => l.includes(" ")));
  const denyMarkers = deny.filter((l) => !l.includes(" ")).map((l) => l.toLowerCase());

  const rows: ExtractRow[] = files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ExtractRow),
  );
  const eligible = rows.filter((r) => allowed(r, allow, denyMarkers, denySessions));
  const history = fitBytes(toHistory(eligible, new Date()));
  if (!history.length) throw new Error("no answered questions from allowed projects in those rows");
  const dates = eligible.map((r) => r.ts!).filter(Boolean).sort();
  console.log(`${rows.length} rows; ${eligible.length} from allowed projects; sending the newest ${history.length} answered questions`);
  console.log(`rows span ${dates[0]?.slice(0, 10)} to ${dates.at(-1)?.slice(0, 10)} (the extractor freezes at its own cutoff; rerun it with a later one for newer history)`);

  // The runner's own key, from the runner's own env file: this never talks to the hosted site.
  const home = resolve(process.env.BUGME_HOME ?? join(homedir(), ".bugme"));
  const envFile = join(home, "runner.env");
  if (!existsSync(envFile)) throw new Error(`no runner at ${home}: start it once with npm run runner`);
  const OWNER_VAR = "LIVE_TOKEN";
  const key = readFileSync(envFile, "utf8").match(new RegExp(`^${OWNER_VAR}=(.+)$`, "m"))?.[1];
  if (!key) throw new Error(`no owner key in ${envFile}`);
  const port = Number(process.env.BUGME_RUNNER_PORT ?? RUNNER_PORT);
  const res = await fetch(`http://127.0.0.1:${port}/api/me/onboarding`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ history }),
  }).catch(() => null);
  if (!res) throw new Error(`the runner isn't answering on port ${port}: npm run runner`);
  const data = (await res.json()) as { run?: { note: unknown[] }; error?: string };
  if (!res.ok || !data.run) throw new Error(data.error ?? `HTTP ${res.status}`);
  console.log(`Drafted a ${data.run.note.length}-line note. Open http://localhost:${port}/me#/welcome to read it and do the interview.`);
}

if (process.argv[1]?.endsWith("onboard.mjs")) {
  main().catch((e) => {
    console.error(`onboard: ${(e as Error).message}`);
    process.exit(1);
  });
}
