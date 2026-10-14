// The Worker: serves the page from public/ (Workers static assets) and the JSON API under /api/.
//
//   GET  /api/queue   the persona, default rules and facts, the decisions, and a routed card for each
//   POST /api/route   route one decision under the visitor's current rules and facts
//   POST /api/answer  check a choice for pushback, or finalize it and open the sealed guess
//   POST /api/fact    turn a stated reason into proposed guidance and the decisions to re-route
//   POST /api/ask     answer a clarifying question from what the agent provided, or say what is missing
//   POST /api/parse   pick the choice, reasons, conditions and questions out of the person's thinking out loud
//   POST /api/converse one turn of the decision conversation: Bug Me's reading of the thread and its next turn
//   POST /api/dispatch a rough task becomes a brief, on Jordan's synthetic tools (docs/STAGE-8.md)
//
// The live queue (docs/STAGE-7.md), for the one owner, all 404 unless LIVE_TOKEN is set:
//   GET  /me                    the same app, in live mode
//   POST /api/me/login          trade the token for the owner cookie
//   POST /api/me/tickets        an agent's ask (the MCP server): routed, settled by rule or queued
//   GET  /api/me/tickets/<id>   what the asking session is told now
//   GET  /api/me/queue          the owner's queue, in /api/queue's shape
//   POST /api/me/resolve        the owner's answer, sent back to the asking session
//   POST /api/me/context        save the owner's rules and facts
//   POST /api/me/facts/edit     edit (text) or delete (text: null) one fact by id
//   POST /api/me/{route,answer,fact,ask,parse,converse}  the same calls as above, in the owner's world
//   POST /api/me/catalog        the owner's tool and skill names and statuses (mcp/bugme.mjs sync-catalog)
//   GET  /api/me/briefs         the owner's briefs and catalog
//   POST /api/me/dispatch       a rough task becomes a stored brief, never cached or recorded
//   POST /api/me/briefs/<id>/dispatched  the fields as copied; starts the clock
//   POST /api/me/briefs/<id>/report      the dispatched session's report (report_to_bug_me)
//
// Which model answers is decided in model.ts: the deterministic fake when FAKE_MODEL is set or no
// API key exists, otherwise live Claude behind the cache and the spend cap.

import { MAX_EVIDENCE_CHARS, MAX_FACTS, MAX_REASON_CHARS, MAX_REROUTES_PER_FACT, MAX_RULE_CHARS, MAX_ONBOARD_HISTORY, MAX_RULES, ONBOARD_MAX_BODY_BYTES, RUNNER_HEADER } from "../shared/constants";
import { ConverseError, parseConverseRequest } from "../shared/converse";
import { enforceSettleInvariant, verifiedConflicts, verifiedQuotes } from "../shared/route";
import type { Card, Decision, Fact, Persona, RouteOutput, Rule, Source } from "../shared/types";
import { type Titles, plainOptions } from "../shared/titles";
import { byId, decisions, defaultFacts, defaultRules, jordanHistory, persona, publicCatalog, publicDecision } from "./data";
import { OnboardingError, type OnboardingRun, factsFromNote, parseAnswers, parseHistory, parseInterview, parseNote } from "../shared/onboarding";
import { type Catalog, DispatchError, MAX_ANSWERS_CHARS, MAX_TASK_CHARS, finishBrief, parseCatalog, parseEdits, parseLaunch, parseReport } from "../shared/dispatch";
import { type Env, type ModelCtx, ModelUnavailable, NeedsSession, PUBLIC_CTX, askFor, converseFor, dispatchFor, factFor, interviewFor, noteFor, parseFor, reviseFor, routeFor, titlesFor, walkFor } from "./model";
import { type WalkInput, walkInput } from "../shared/walk";
import { WALK_PROMPT_VERSION } from "../shared/prompts";
import { ALREADY_KEPT, AskError, BRIEF_ID_RE, MAX_OTHERS_IN_PROMPT, OWNER_SETTLE_LIMITS, type OwnerNote, type Ticket, askBrief, askProjectName, briefId, decisionFromAsk, ownerPersona, parseResolution, reply, STALE_IMPORT, STALE_STEP, ticketId, waitingMinutes } from "./live";
import { isOwner, ownerCookie, sameString, usableToken } from "./liveAuth";
import { issueSession, sessionValid, verifyTurnstile } from "./session";
import { BadRequest, readLimited } from "./body";
import { SealError, importSealKey, seal, sha256Hex, unseal } from "./seal";

export { SpendCounter } from "./spend";
export { OwnerQueue } from "./owner";

/**
 * Whose decisions a call is about. The public world is the simulation (Jordan's fixtures, the visitor's
 * rules and facts in each request). The owner's world is the live queue: decisions are tickets, and the
 * rules and facts are the owner's, saved whenever a request carries them.
 */
interface World {
  ctx: ModelCtx;
  decisionOf(id: unknown): Promise<Decision>;
  /** Every other decision the fact prompt lists, and the ones still waiting. */
  others(d: Decision): Promise<Decision[]>;
  defaults(): Promise<{ rules: Rule[]; facts: Fact[] }>;
  /**
   * The owner's world saves a request's rules and facts and reads back the current ones with their
   * revision in one step, so routing never pairs old rules with a newer revision.
   */
  snapshot?(rules?: Rule[], facts?: Fact[]): Promise<{ rules: Rule[]; facts: Fact[]; rev: number }>;
  /** The option labels in the person's terms that the card shows (docs/STAGE-6F.md), if any. */
  labelsOf(d: Decision): Promise<Record<string, string> | undefined>;
  canSpend: boolean;
}



function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await readLimited(req);
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") throw new Error();
    return v;
  } catch {
    throw new BadRequest("body is not a JSON object");
  }
}

function decisionOf(id: unknown): Decision {
  const d = typeof id === "string" ? byId.get(id) : undefined;
  if (!d) throw new BadRequest("unknown decision id");
  return d;
}

function publicWorld(env: Env, canSpend: boolean): World {
  return {
    ctx: PUBLIC_CTX,
    decisionOf: async (id) => decisionOf(id),
    // The fact prompt lists every other decision, not just the ones still waiting, so its wording (and
    // so a recorded answer) does not depend on what the visitor happened to answer first.
    others: async (d) => decisions.filter((x) => x.id !== d.id),
    defaults: async () => ({ rules: defaultRules, facts: defaultFacts }),
    // From the card's own source (recorded or cached titles). Never spends: the card's load already
    // asked, and a turn's reservation is never crowded out by them.
    labelsOf: async (d) => (await titlesFor(env, false, d, PUBLIC_CTX).catch(() => null))?.out.labels,
    canSpend,
  };
}

function ownerQueue(env: Env) {
  if (!env.OWNER) throw new Error("the OWNER Durable Object is not bound");
  return env.OWNER.get(env.OWNER.idFromName("owner"));
}

/** The owner's persona, with the projects their tickets name. */
function ownerPersonaOf(tickets: Pick<Ticket, "decision" | "project_name">[], note?: OwnerNote): Persona {
  const byId = new Map(tickets.map((t) => [t.decision.project, t.project_name ?? t.decision.project]));
  return ownerPersona([...byId].map(([id, name]) => ({ id, name })), note);
}

async function ownerWorld(env: Env): Promise<World> {
  const q = ownerQueue(env);
  const shown = await q.shown();
  const open = shown.filter((t) => t.status === "open" || t.status === "reopened").map((t) => t.decision);
  return {
    // Never the recorded run or the response cache: nothing from a real queue is stored outside it.
    ctx: { persona: ownerPersonaOf(shown, await q.note()), store: false, settle: OWNER_SETTLE_LIMITS },
    decisionOf: async (id) => {
      const t = typeof id === "string" ? await q.ticket(id) : undefined;
      if (!t) throw new BadRequest("unknown ticket");
      return t.decision;
    },
    others: async (d) => open.filter((x) => x.id !== d.id).slice(-MAX_OTHERS_IN_PROMPT),
    defaults: () => q.context(),
    snapshot: (rules, facts) => q.snapshot(rules, facts),
    // Nothing from the real queue is cached, so the labels are the ones stored on the ticket's card.
    labelsOf: async (d) => (await q.ticket(d.id))?.card?.labels,
    // The signed-in owner may make live calls without a human check; the daily cap still applies.
    canSpend: true,
  };
}

function cleanText(v: unknown, max: number, field: string): string {
  if (typeof v !== "string") throw new BadRequest(`${field} must be a string`);
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length > max) throw new BadRequest(`${field} is longer than ${max} characters`);
  return t;
}

/** The rules and facts a request carries, bounded; absent means the world's own. The owner's are saved. */
async function contextIn(b: Record<string, unknown>, w: World): Promise<{ rules: Rule[]; facts: Fact[]; rev: number }> {
  const c = context(b, await w.defaults());
  if (!w.snapshot) return { ...c, rev: 0 };
  return b.rules !== undefined || b.facts !== undefined ? w.snapshot(c.rules, c.facts) : w.snapshot();
}

/**
 * A dispatch request's task and answers (docs/STAGE-8.md), trimmed but otherwise exactly as written:
 * the session gets the person's own words, so "exactly two spaces" must survive.
 */
function dispatchInput(b: Record<string, unknown>): { task: string; answers: string } {
  const exact = (v: unknown, max: number, field: string) => {
    if (typeof v !== "string") throw new BadRequest(`${field} must be a string`);
    const t = v.trim();
    if (t.length > max) throw new BadRequest(`${field} is longer than ${max} characters`);
    return t;
  };
  const task = exact(b.task, MAX_TASK_CHARS, "task");
  if (!task) throw new BadRequest("task is required");
  return { task, answers: b.answers === undefined ? "" : exact(b.answers, MAX_ANSWERS_CHARS, "answers") };
}

/** A fact's scope is "all" or a project id; a live project's id can be as long as its name (60). */
const MAX_SCOPE_CHARS = 60;

function context(b: Record<string, unknown>, defaults: { rules: Rule[]; facts: Fact[] }): { rules: Rule[]; facts: Fact[] } {
  const rules = b.rules === undefined ? defaults.rules : b.rules;
  const facts = b.facts === undefined ? defaults.facts : b.facts;
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new BadRequest(`rules must be a list of at most ${MAX_RULES}`);
  if (!Array.isArray(facts) || facts.length > MAX_FACTS) throw new BadRequest(`facts must be a list of at most ${MAX_FACTS}`);
  return {
    rules: rules.map((r, i) => ({ id: cleanText(r?.id, 12, `rules[${i}].id`), text: cleanText(r?.text, MAX_RULE_CHARS, `rules[${i}].text`) })),
    facts: facts.map((f, i) => ({
      id: cleanText(f?.id, 12, `facts[${i}].id`),
      text: cleanText(f?.text, MAX_RULE_CHARS, `facts[${i}].text`),
      source: cleanText(f?.source ?? "", 200, `facts[${i}].source`),
      scope: cleanText(f?.scope ?? "all", MAX_SCOPE_CHARS, `facts[${i}].scope`),
    })),
  };
}

export async function contextVersion(rules: Rule[], facts: Fact[]): Promise<string> {
  return (await sha256Hex({ rules, facts })).slice(0, 16);
}

/** Route one decision and turn the result into a public card with its hidden part sealed. */
async function card(env: Env, canSpend: boolean, key: CryptoKey, d: Decision, rules: Rule[], facts: Fact[], ctx: ModelCtx = PUBLIC_CTX): Promise<Card> {
  // The emoji and title are display only: a card without them still works, so their failure is not the
  // card's. Routing goes first, so the title's spend reservation can never crowd out the route itself.
  const { out, source } = await routeFor(env, canSpend, d, rules, facts, ctx);
  const titles = await titlesFor(env, canSpend, d, ctx).catch(() => null);
  return cardFromRoute(key, d, out, source, rules, facts, titles, ctx);
}

/**
 * The route for an ask that couldn't be routed (docs/STAGE-7.md): the owner's decision, with no guess
 * and each option sent down as itself, so it can still be answered without a model call.
 */
function unroutedRoute(d: Decision, why: string): RouteOutput {
  return {
    route: "decide",
    settle_option: "",
    reversible: "no",
    cost: "moderate",
    clearing_rule: "",
    rule_quoted: "",
    fact_quoted: "",
    why_here: `Bug Me couldn't route this (${why}), so it's yours.`,
    headline: d.question,
    in_your_terms: "",
    briefing: d.context.slice(0, 400),
    option_notes: d.options.map((o) => ({ option: o.key, pros: [], cons: [], consequence: "" })),
    problem: "fine",
    guess: d.options.map((o) => ({ option: o.key, p: 1 / d.options.length })),
    conflicts: [],
    send_down: d.options.map((o) => ({ option: o.key, instruction: `David chose: ${o.label}.` })),
  };
}

async function cardFromRoute(
  key: CryptoKey,
  d: Decision,
  out: RouteOutput,
  source: Source,
  rules: Rule[],
  facts: Fact[],
  titles: { out: Titles } | null,
  ctx: ModelCtx,
): Promise<Card> {
  const inv = enforceSettleInvariant(out, d, rules, facts, ctx.settle);
  const quotes = verifiedQuotes(out, rules, facts);
  const version = await contextVersion(rules, facts);
  const conflicts = verifiedConflicts(out, rules, facts);
  const sealed = await seal(
    key,
    { id: d.id, guess: out.guess, conflicts, send_down: out.send_down },
    { decisionId: d.id, optionKeys: d.options.map((o) => o.key), contextVersion: version },
  );
  return {
    id: d.id,
    route: inv.route,
    model_route: out.route,
    settle_option: inv.settle_option,
    ...(inv.adjusted ? { adjusted: inv.adjusted } : {}),
    reversible: out.reversible,
    cost: out.cost,
    ...quotes,
    why_here: out.why_here,
    headline: out.headline,
    in_your_terms: out.in_your_terms,
    briefing: out.briefing,
    option_notes: out.option_notes,
    problem: out.problem,
    source,
    sealed,
    ...(titles ? { emoji: titles.out.emoji, title: titles.out.title, done: titles.out.done, ...(Object.keys(titles.out.labels).length ? { labels: titles.out.labels } : {}) } : {}),
  };
}

/** The public walk's input, from the visitor's copy of a demo brief: trimmed and capped like any input. */
function walkInputFrom(b: Record<string, unknown>): WalkInput {
  const t = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const what = t(b.what, 200);
  if (!what) throw new BadRequest("what is required");
  const tools = Array.isArray(b.tools) ? b.tools.map((x) => t(x, 80)).filter(Boolean).slice(0, 10).sort() : [];
  return { what, why: t(b.why, 200), headline: t(b.headline, 120), goal: t(b.goal, 200), tools };
}

/** The owner's onboarding steps (docs/STAGE-10.md, 10b). The import alone takes a larger body. */
async function onboardingRoute(req: Request, env: Env, path: string, q: ReturnType<typeof ownerQueue>): Promise<Response> {
  const ctx: ModelCtx = { persona: ownerPersonaOf(await q.shown(), await q.note()), store: false };
  if (req.method === "GET" && path === "/api/me/onboarding") return json({ run: (await q.onboarding()) ?? null });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (path === "/api/me/onboarding") {
    const raw = await readLimited(req, ONBOARD_MAX_BODY_BYTES);
    let b: { history?: unknown };
    try {
      b = JSON.parse(raw);
    } catch {
      throw new BadRequest("body is not JSON");
    }
    const history = parseHistory(b.history, MAX_ONBOARD_HISTORY);
    const { rules } = await q.context();
    const { out, source } = await noteFor(env, true, rules, history, ctx);
    const run: OnboardingRun = { id: crypto.randomUUID().slice(0, 8), created_at: new Date().toISOString(), history, note: out, sources: { note: source } };
    await q.setOnboarding(run);
    return json({ run });
  }
  const run = await q.onboarding();
  if (!run) return json({ error: "no onboarding run yet: npm run onboard on the runner" }, 404);
  const b = await body(req);
  // Every step names the run the page showed: a newer import replaces it, and nothing acts on that unseen.
  if (String(b.run ?? "") !== run.id) return json({ error: STALE_IMPORT }, 409);
  // A kept note is the owner's now: corrections go through the facts in Rules.
  if (run.kept_at && path !== "/api/me/onboarding/keep") return json({ error: ALREADY_KEPT }, 409);
  // …and the version of it the page showed: a step another tab finished since isn't answered unseen.
  if (!run.kept_at && Number(b.rev ?? 0) !== (run.rev ?? 0)) return json({ error: STALE_STEP }, 409);
  if (path === "/api/me/onboarding/interview") {
    const { out, source } = await interviewFor(env, true, run.history, run.note, ctx);
    const r = await q.commitOnboarding(run, { ...run, questions: out, answers: undefined, revised: undefined, sources: { note: run.sources?.note ?? "live", questions: source } });
    return r.ok ? json({ run: r.run }) : json({ error: r.error }, 409);
  }
  if (path === "/api/me/onboarding/revise") {
    if (!run.questions) throw new BadRequest("interview first");
    const answers = parseAnswers(b.answers, run.questions);
    const { out, source } = await reviseFor(env, true, run.history, run.note, run.questions, answers, ctx);
    const r = await q.commitOnboarding(run, { ...run, answers, revised: out, sources: { note: run.sources?.note ?? "live", questions: run.sources?.questions, revised: source } });
    return r.ok ? json({ run: r.run }) : json({ error: r.error }, 409);
  }
  if (path === "/api/me/onboarding/keep") {
    const facts = factsFromNote(run, MAX_RULE_CHARS);
    const lines = facts.map((f) => f.text);
    const r = await q.keepNote(run, facts, { lines, fact_ids: facts.map((f) => f.id), source: `Drafted by Bug Me from ${run.history.length} of your decisions${run.revised ? " and corrected in the interview" : ""}, ${run.created_at.slice(0, 10)}.` }, MAX_FACTS);
    if (!r.ok) return json({ error: r.error }, 409);
    return json({ ok: true, added: r.added, run: await q.onboarding() });
  }
  return json({ error: "not found" }, 404);
}

/** Live calls can be made: an API key, or the runner's Claude login (docs/STAGE-9.md). */
const liveAvailable = (env: Env) => Boolean(env.ANTHROPIC_API_KEY || env.LOCAL_MODEL_URL) && !env.FAKE_MODEL;

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  // The live queue doesn't exist without its token, whatever else is configured.
  if (path === "/api/me" || path.startsWith("/api/me/")) {
    if (!usableToken(env.LIVE_TOKEN) || !env.OWNER) return json({ error: "not found" }, 404);
    return handleOwner(req, env, path, await importSealKey(env.SEAL_KEY));
  }
  const key = await importSealKey(env.SEAL_KEY);

  if (path === "/api/queue" && req.method === "GET") {
    // A card the model cannot evaluate is listed as unavailable rather than failing the whole queue.
    const cards = await Promise.all(
      decisions.map((d) =>
        // The default queue never spends: it is served from the recorded run, the cache, or not at all.
        card(env, false, key, d, defaultRules, defaultFacts).catch((e) => {
          if (e instanceof ModelUnavailable || e instanceof NeedsSession) return { id: d.id, unavailable: e.message };
          throw e;
        }),
      ),
    );
    return json({
      persona,
      rules: defaultRules,
      facts: defaultFacts,
      decisions: decisions.map(publicDecision),
      cards,
      catalog: publicCatalog,
      live_available: liveAvailable(env),
      mode: env.FAKE_MODEL ? "fake" : liveAvailable(env) ? "live" : "recorded",
      turnstile_site_key: env.TURNSTILE_SECRET ? (env.TURNSTILE_SITE_KEY ?? null) : null,
    });
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const ip = req.headers.get("cf-connecting-ip");
  if (env.LIMITER && !(await env.LIMITER.limit({ key: ip ?? "unknown" })).success) {
    return json({ error: "too many requests; slow down a little", unavailable: true }, 429);
  }
  const b = await body(req);

  if (path === "/api/session") {
    if (!env.TURNSTILE_SECRET) return json({ session: null, gate: false });
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, String(b.token ?? ""), ip);
    if (!ok) return json({ error: "the human check did not pass" }, 403);
    return json({ session: await issueSession(env.SEAL_KEY!) });
  }

  // Live calls need a session only when the Turnstile gate is configured.
  const canSpend = !env.TURNSTILE_SECRET || (await sessionValid(env.SEAL_KEY!, req.headers.get("x-bugme-session")));

  if (path === "/api/dispatch") {
    // Jordan's world: the visitor's rules and facts, Jordan's synthetic tools. The brief lives in the
    // visitor's browser; its command is illustration only (docs/STAGE-8.md).
    const { task, answers } = dispatchInput(b);
    const { rules, facts } = context(b, { rules: defaultRules, facts: defaultFacts });
    const { out, source } = await dispatchFor(env, canSpend, task, answers, publicCatalog, rules, facts, PUBLIC_CTX);
    return json({ brief: finishBrief(out, publicCatalog, { id: briefId(), task, answers, now: new Date(), owner: false }), source });
  }

  if (path === "/api/onboarding/draft" || path === "/api/onboarding/interview" || path === "/api/onboarding/revise") {
    // Jordan's onboarding (docs/STAGE-10.md): the history is the fixture; the page sends back what the
    // earlier steps returned, checked again here against that history.
    try {
      const history = jordanHistory;
      if (path === "/api/onboarding/draft") {
        const { out, source } = await noteFor(env, canSpend, defaultRules, history, PUBLIC_CTX);
        return json({ history, note: out, source });
      }
      // The page sends back the lists the earlier steps returned; each is checked again against the history.
      const note = parseNote({ lines: b.note }, history);
      if (path === "/api/onboarding/interview") {
        const { out, source } = await interviewFor(env, canSpend, history, note, PUBLIC_CTX);
        return json({ questions: out, source });
      }
      const questions = parseInterview({ questions: b.questions }, note);
      const { out, source } = await reviseFor(env, canSpend, history, note, questions, parseAnswers(b.answers, questions), PUBLIC_CTX);
      return json({ lines: out, source });
    } catch (e) {
      if (e instanceof OnboardingError) throw new BadRequest(e.message);
      throw e;
    }
  }

  if (path === "/api/walk") {
    // Jordan's demo (docs/STAGE-9.md): the brief lives in the visitor's browser, so the canonical input
    // comes from it; the three demo tasks' items are recorded.
    const { out, source } = await walkFor(env, canSpend, walkInputFrom(b), PUBLIC_CTX);
    return json({ steps: out, source });
  }
  return (await modelCall(env, key, path.slice("/api".length), b, publicWorld(env, canSpend))) ?? json({ error: "not found" }, 404);
}

/**
 * The calls the page makes about one decision, in either world. Returns null for a path that isn't
 * one of them. `onCard` lets the owner's world keep a re-routed card.
 */
async function modelCall(
  env: Env,
  key: CryptoKey,
  path: string,
  b: Record<string, unknown>,
  w: World,
  /** The owner's world stores a re-routed card and answers with the card the ticket now has. */
  onCard?: (c: Card, d: Decision, rev: number) => Promise<Card | undefined>,
): Promise<Response | null> {
  const { canSpend, ctx } = w;

  if (path === "/route") {
    const d = await w.decisionOf(b.id);
    // The rules this card is routed under, with their revision: if they change before it is stored, it can't settle anything.
    const { rules, facts, rev } = await contextIn(b, w);
    const c = await card(env, canSpend, key, d, rules, facts, ctx);
    return json((await onCard?.(c, d, rev)) ?? c);
  }

  if (path === "/answer") {
    const d = await w.decisionOf(b.id);
    const choice = typeof b.choice === "string" ? b.choice : "";
    if (!d.options.some((o) => o.key === choice)) throw new BadRequest("choice is not an option of this decision");
    const opened = await unseal(key, String(b.sealed ?? ""), d.id, d.options.map((o) => o.key));
    if (b.stage === "check") {
      // Before the answer is final: reveal only whether this choice contradicts a standing fact or rule.
      const hit = opened.conflicts.find((c) => c.option === choice);
      return json({ pushback: hit ? hit.quoted : null });
    }
    const send = opened.send_down.find((s) => s.option === choice);
    return json({ guess: opened.guess, conflicts: opened.conflicts, send_down: send?.instruction ?? "" });
  }

  if (path === "/fact") {
    const d = await w.decisionOf(b.id);
    const { rules, facts } = await contextIn(b, w);
    // A thread can end outside the listed options (docs/STAGE-6.md): Jordan's own course, or the
    // question rejected. Those carry the course in Jordan's words and never a listed option's key.
    const outcome = b.outcome ?? "option";
    if (outcome !== "option" && outcome !== "other" && outcome !== "rejected") throw new BadRequest("outcome must be option, other or rejected");
    const choice = outcome === "option" && typeof b.choice === "string" ? b.choice : "";
    if (outcome === "option" && !d.options.some((o) => o.key === choice)) throw new BadRequest("choice is not an option of this decision");
    const outside = outcome === "option" ? undefined : { kind: outcome as "other" | "rejected", course: cleanText(b.course, MAX_REASON_CHARS, "course") };
    if (outside && !outside.course) throw new BadRequest("course is required for other and rejected");
    const reason = cleanText(b.reason, MAX_EVIDENCE_CHARS, "reason");
    const others = await w.others(d);
    const byOther = new Map(others.map((x) => [x.id, x]));
    const waitingIds = Array.isArray(b.waiting) ? b.waiting.filter((x): x is string => typeof x === "string") : [];
    const waiting = waitingIds.map((id) => byOther.get(id)).filter((x): x is Decision => Boolean(x));
    const { out, source } = await factFor(env, canSpend, d, choice, reason, rules, facts, others, outside, ctx);
    // Re-route candidates: decisions sharing a topic tag with this one, plus the model's suggestions,
    // limited to known waiting ids and capped, so one fact costs a bounded number of calls.
    const known = new Set(waiting.map((x) => x.id));
    const byTag = waiting.filter((x) => x.tags.some((t) => d.tags.includes(t))).map((x) => x.id);
    const suggested = out.may_affect.filter((id) => known.has(id));
    const reroute = out.kind === "none" ? [] : [...new Set([...suggested, ...byTag])].slice(0, MAX_REROUTES_PER_FACT);
    return json({ ...out, may_affect: suggested, reroute, source });
  }

  if (path === "/ask") {
    const d = await w.decisionOf(b.id);
    const question = cleanText(b.question, MAX_REASON_CHARS, "question");
    const { out, source } = await askFor(env, canSpend, d, question, ctx);
    return json({ ...out, source });
  }

  if (path === "/parse") {
    const d = await w.decisionOf(b.id);
    // Not whitespace-collapsed: marks must be literal quotes of exactly what the person said.
    if (typeof b.text !== "string") throw new BadRequest("text must be a string");
    const text = b.text.trim();
    if (!text || text.length > MAX_REASON_CHARS) throw new BadRequest(`text must be 1 to ${MAX_REASON_CHARS} characters`);
    const { out, source } = await parseFor(env, canSpend, d, text, ctx);
    return json({ ...out, source });
  }

  if (path === "/converse") {
    const d = await w.decisionOf(b.id);
    const { rules, facts } = await contextIn(b, w);
    let req: ReturnType<typeof parseConverseRequest>;
    try {
      req = parseConverseRequest(b, d);
    } catch (e) {
      if (e instanceof ConverseError) throw new BadRequest(e.message);
      throw e;
    }
    // Bug Me talks in the person's terms: the same option labels the card shows (docs/STAGE-6F.md);
    // without them, the agent's.
    const { out, source } = await converseFor(env, canSpend, plainOptions(d, await w.labelsOf(d)), req.card, req.turns, rules, facts, ctx);
    return json({ ...out, source });
  }

  return null;
}

/** The send-down instruction for the option a card settles on, from inside its seal. */
async function settleInstruction(key: CryptoKey, d: Decision, c: Card): Promise<string> {
  if (c.route !== "settle") return "";
  const opened = await unseal(key, c.sealed, d.id, d.options.map((o) => o.key));
  return opened.send_down.find((s) => s.option === c.settle_option)?.instruction ?? "";
}

/** The live queue (docs/STAGE-7.md). Without LIVE_TOKEN, none of it exists. */
async function handleOwner(req: Request, env: Env, path: string, key: CryptoKey): Promise<Response> {
  const liveKey = env.LIVE_TOKEN!;
  const jsonBody = (req.headers.get("content-type") ?? "").startsWith("application/json");

  if (path === "/api/me/login" && req.method === "POST") {
    if (!jsonBody) return json({ error: "expected JSON" }, 415);
    const b = await body(req);
    if (typeof b.k !== "string" || !sameString(b.k, liveKey)) return json({ error: "that link is not valid" }, 403);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": await ownerCookie(liveKey) },
    });
  }
  if (!(await isOwner(req, liveKey))) return json({ error: "sign in with your link first", needs_owner: true }, 401);
  // A JSON body (with SameSite=Strict on the cookie) is what keeps another site from posting here.
  if (req.method === "POST" && !jsonBody) return json({ error: "expected JSON" }, 415);

  const q = ownerQueue(env);
  const ticketPath = path.match(/^\/api\/me\/tickets\/(t-[a-z0-9]{1,32})$/);
  if (ticketPath && req.method === "GET") {
    const t = await q.ticket(ticketPath[1]);
    return t ? json(reply(t)) : json({ error: "unknown ticket" }, 404);
  }

  if (path === "/api/me/queue" && req.method === "GET") {
    const shown = await q.shown();
    const answered = await q.recentlyAnswered();
    const { rules, facts } = await q.context();
    const now = new Date();
    return json({
      persona: ownerPersonaOf([...shown, ...answered], await q.note()),
      rules,
      facts,
      decisions: shown.map((t) => publicDecision({ ...t.decision, waiting_minutes: waitingMinutes(t, now) })),
      cards: shown.map((t) => t.card),
      // Set aside on any device: the page lists them, and Resume brings them back.
      aside: shown.filter((t) => t.status === "set-aside" && t.aside).map((t) => ({ id: t.decision.id, ...t.aside })),
      // Answered in the last day: not waiting, but the page keeps their follow-ups (a late reason, guidance) working.
      answered: answered.map((t) => ({ decision: publicDecision(t.decision), card: t.card })),
      live_available: liveAvailable(env),
      mode: env.FAKE_MODEL ? "fake" : liveAvailable(env) ? "live" : "recorded",
      owner: true,
      turnstile_site_key: null,
    });
  }

  if (path === "/api/me/briefs" && req.method === "GET") {
    // Asks still waiting on the owner, per brief, so a launched brief can say "waiting on you" (docs/STAGE-9.md).
    const waiting: Record<string, string[]> = {};
    for (const t of await q.shown()) {
      if (t.brief && (t.status === "open" || t.status === "reopened")) (waiting[t.brief] ??= []).push(t.decision.id);
    }
    return json({ briefs: await q.briefs(), catalog: await q.catalog(), waiting });
  }

  // Onboarding on the owner's own history (docs/STAGE-10.md, 10b) runs only on the runner, so the history
  // never passes through Cloudflare; every model call is the owner's, uncached and unrecorded.
  if (path === "/api/me/onboarding" || path.startsWith("/api/me/onboarding/")) {
    if (!env.LOCAL_MODEL_URL) return json({ error: "Onboarding on your own history runs on the runner (npm run runner)." }, 404);
    try {
      return await onboardingRoute(req, env, path, q);
    } catch (e) {
      if (e instanceof OnboardingError) throw new BadRequest(e.message);
      throw e;
    }
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = await body(req);

  if (path === "/api/me/catalog") {
    let c: Catalog;
    try {
      c = parseCatalog(b);
    } catch (e) {
      if (e instanceof DispatchError) throw new BadRequest(e.message);
      throw e;
    }
    await q.setCatalog(c);
    return json({ ok: true, servers: c.servers.length, skills: c.skills.length });
  }

  if (path === "/api/me/dispatch") {
    const { task, answers } = dispatchInput(b);
    const { rules, facts } = await q.snapshot();
    const catalog = await q.catalog();
    // Never the recorded run or the cache: the owner's task stays in the owner's Durable Object.
    const ctx: ModelCtx = { persona: ownerPersonaOf(await q.shown(), await q.note()), store: false };
    const { out, source } = await dispatchFor(env, true, task, answers, catalog, rules, facts, ctx);
    const brief = finishBrief(out, catalog, { id: briefId(), task, answers, now: new Date(), owner: true });
    await q.addBrief(brief);
    return json({ brief, source });
  }

  const walkPath = path.match(/^\/api\/me\/briefs\/(b-[a-z0-9]{10})\/walk$/);
  if (walkPath) {
    const brief = await q.brief(walkPath[1]);
    if (!brief) return json({ error: "unknown brief" }, 404);
    const item = Number(b.item);
    if (!Number.isInteger(item) || !brief.prerequisites[item]) return json({ error: "no such item" }, 400);
    const kept = brief.walks?.find((w) => w.item === item && w.what === brief.prerequisites[item].what && w.version === WALK_PROMPT_VERSION);
    if (kept) return json({ steps: kept.steps, source: kept.source });
    // The owner's item never reaches the recorded run or the cache.
    const { out, source } = await walkFor(env, true, walkInput(brief, item, await q.catalog()), { persona: ownerPersonaOf([]), store: false });
    await q.walk(brief.id, { item, what: brief.prerequisites[item].what, steps: out, source, version: WALK_PROMPT_VERSION });
    return json({ steps: out, source });
  }

  const briefPath = path.match(/^\/api\/me\/briefs\/(b-[a-z0-9]{10})\/(dispatched|report|launch)$/);
  if (briefPath && BRIEF_ID_RE.test(briefPath[1])) {
    try {
      if (briefPath[2] === "dispatched") {
        const next = await q.dispatched(briefPath[1], parseEdits(b, await q.catalog()));
        return next ? json({ brief: next }) : json({ error: "unknown brief" }, 404);
      }
      if (briefPath[2] === "launch") {
        // The runner's record of its launch (docs/STAGE-9.md); 409 with the record as it stands when refused.
        const r = await q.launch(briefPath[1], parseLaunch(b));
        if (!r) return json({ error: "unknown brief" }, 404);
        return json({ brief: r.brief, ok: r.ok }, r.ok ? 200 : 409);
      }
      const next = await q.report(briefPath[1], parseReport(b));
      return next ? json({ ok: true, brief: briefPath[1] }) : json({ error: "unknown brief" }, 404);
    } catch (e) {
      if (e instanceof DispatchError) throw new BadRequest(e.message);
      throw e;
    }
  }

  if (path === "/api/me/tickets") {
    let d: Decision;
    try {
      d = decisionFromAsk(b, ticketId());
    } catch (e) {
      if (e instanceof AskError) throw new BadRequest(e.message);
      throw e;
    }
    const projectName = askProjectName(b);
    const { rules, facts, rev } = await q.snapshot();
    const ctx: ModelCtx = { persona: ownerPersonaOf([...(await q.shown()), { decision: d, project_name: projectName }], await q.note()), store: false, settle: OWNER_SETTLE_LIMITS };
    // Routing can fail (no key, today's budget spent, a bad answer): the ask is kept, as the owner's to decide.
    let c: Card;
    let unrouted: string | undefined;
    try {
      c = await card(env, true, key, d, rules, facts, ctx);
    } catch (e) {
      if (!(e instanceof ModelUnavailable || e instanceof NeedsSession)) throw e;
      unrouted = e.message;
      c = await cardFromRoute(key, d, unroutedRoute(d, e.message), "code", rules, facts, null, ctx);
    }
    const t = await q.add(d, c, await settleInstruction(key, d, c), rev, unrouted, projectName, askBrief(b));
    return json(reply(t));
  }

  if (path === "/api/me/resolve") {
    const t = await q.ticket(String(b.id ?? ""));
    if (!t) throw new BadRequest("unknown ticket");
    let r;
    try {
      r = parseResolution(b, t.decision);
    } catch (e) {
      if (e instanceof AskError) throw new BadRequest(e.message);
      throw e;
    }
    const out = await q.resolve(t.decision.id, r);
    if ("refused" in out) throw new BadRequest(out.refused);
    return json(reply(out.ticket));
  }

  if (path === "/api/me/facts/edit") {
    const id = cleanText(b.id, 12, "id");
    const text = b.text === null ? null : cleanText(b.text, MAX_RULE_CHARS, "text");
    if (text === "") throw new BadRequest("text is empty; send null to delete the fact");
    return json({ facts: await q.editFact(id, text) });
  }

  if (path === "/api/me/context") {
    const c = context(b, await q.context());
    await q.setContext(c.rules, c.facts);
    return json({ ok: true });
  }

  const w = await ownerWorld(env);
  const res = await modelCall(env, key, path.slice("/api/me".length), b, w, async (c, d, rev) => {
    // The page gets the card the ticket now has: a settled ticket stays settled, a reopened one stays the owner's.
    return (await q.reroute(d.id, c, await settleInstruction(key, d, c), rev))?.card;
  });
  return res ?? json({ error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Under the runner (docs/STAGE-9.md) the Worker listens on loopback behind the runner's guards; a
    // request that didn't come through the runner (another local process, a DNS-rebound page) gets nothing.
    if (env.LOCAL_MODEL_URL && (!usableToken(env.LOCAL_MODEL_TOKEN) || !sameString(req.headers.get(RUNNER_HEADER) ?? "", env.LOCAL_MODEL_TOKEN))) {
      return new Response("Not found", { status: 404 });
    }
    const url = new URL(req.url);
    // The owner's page is the same app in live mode (docs/STAGE-7.md); it doesn't exist without LIVE_TOKEN.
    if (url.pathname === "/me") {
      if (!usableToken(env.LIVE_TOKEN)) return new Response("Not found", { status: 404 });
      const page = await env.ASSETS.fetch(new Request(new URL("/app", url), req));
      const res = new Response(page.body, page);
      res.headers.set("cache-control", "no-store");
      res.headers.set("x-robots-tag", "noindex");
      return res;
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url.pathname);
      } catch (e) {
        if (e instanceof BadRequest) return json({ error: e.message }, 400);
        if (e instanceof SealError) return json({ error: e.message }, 400);
        if (e instanceof ModelUnavailable) return json({ error: e.message, unavailable: true }, 503);
        if (e instanceof NeedsSession) return json({ error: e.message, needs_session: true }, 401);
        console.error("api error", e);
        return json({ error: "internal error" }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
