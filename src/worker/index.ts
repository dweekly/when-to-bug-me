// The Worker: serves the page from public/ (Workers static assets) and the JSON API under /api/.
//
//   GET  /api/queue   the persona, default rules and facts, the decisions, and a routed card for each
//   POST /api/route   route one decision under the visitor's current rules and facts
//   POST /api/answer  check a choice for pushback, or finalize it and open the sealed guess
//   POST /api/fact    turn a stated reason into proposed guidance and the decisions to re-route
//
// Which model answers is decided in model.ts: the deterministic fake when FAKE_MODEL is set or no
// API key exists, otherwise live Claude behind the cache and the spend cap.

import { MAX_FACTS, MAX_REASON_CHARS, MAX_REROUTES_PER_FACT, MAX_RULE_CHARS, MAX_RULES } from "../shared/constants";
import { enforceSettleInvariant, verifiedQuotes } from "../shared/route";
import type { Card, Decision, Fact, Rule } from "../shared/types";
import { byId, decisions, defaultFacts, defaultRules, persona, publicDecision } from "./data";
import { type Env, ModelUnavailable, NeedsSession, factFor, routeFor } from "./model";
import { issueSession, sessionValid, verifyTurnstile } from "./session";
import { SealError, importSealKey, seal, sha256Hex, unseal } from "./seal";

export { SpendCounter } from "./spend";

/** Largest JSON body accepted on any POST, in bytes. Covers MAX_RULES and MAX_FACTS at their caps with room. */
const MAX_BODY_BYTES = 32_000;

class BadRequest extends Error {}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new BadRequest("request too large");
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

function cleanText(v: unknown, max: number, field: string): string {
  if (typeof v !== "string") throw new BadRequest(`${field} must be a string`);
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length > max) throw new BadRequest(`${field} is longer than ${max} characters`);
  return t;
}

/** The visitor's rules and facts, bounded; absent means the defaults. */
function context(b: Record<string, unknown>): { rules: Rule[]; facts: Fact[] } {
  const rules = b.rules === undefined ? defaultRules : b.rules;
  const facts = b.facts === undefined ? defaultFacts : b.facts;
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new BadRequest(`rules must be a list of at most ${MAX_RULES}`);
  if (!Array.isArray(facts) || facts.length > MAX_FACTS) throw new BadRequest(`facts must be a list of at most ${MAX_FACTS}`);
  return {
    rules: rules.map((r, i) => ({ id: cleanText(r?.id, 12, `rules[${i}].id`), text: cleanText(r?.text, MAX_RULE_CHARS, `rules[${i}].text`) })),
    facts: facts.map((f, i) => ({
      id: cleanText(f?.id, 12, `facts[${i}].id`),
      text: cleanText(f?.text, MAX_RULE_CHARS, `facts[${i}].text`),
      source: cleanText(f?.source ?? "", 200, `facts[${i}].source`),
      scope: cleanText(f?.scope ?? "all", 20, `facts[${i}].scope`),
    })),
  };
}

export async function contextVersion(rules: Rule[], facts: Fact[]): Promise<string> {
  return (await sha256Hex({ rules, facts })).slice(0, 16);
}

/** Route one decision and turn the result into a public card with its hidden part sealed. */
async function card(env: Env, canSpend: boolean, key: CryptoKey, d: Decision, rules: Rule[], facts: Fact[]): Promise<Card> {
  const { out, source } = await routeFor(env, canSpend, d, rules, facts);
  const inv = enforceSettleInvariant(out, d, rules);
  const quotes = verifiedQuotes(out, rules, facts);
  const version = await contextVersion(rules, facts);
  const sealed = await seal(
    key,
    { id: d.id, guess: out.guess, conflicts: out.conflicts, send_down: out.send_down },
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
    problem: out.problem,
    source,
    sealed,
  };
}

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
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
      live_available: Boolean(env.ANTHROPIC_API_KEY) && !env.FAKE_MODEL,
      mode: env.FAKE_MODEL ? "fake" : env.ANTHROPIC_API_KEY ? "live" : "recorded",
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

  if (path === "/api/route") {
    const d = decisionOf(b.id);
    const { rules, facts } = context(b);
    return json(await card(env, canSpend, key, d, rules, facts));
  }

  if (path === "/api/answer") {
    const d = decisionOf(b.id);
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

  if (path === "/api/fact") {
    const d = decisionOf(b.id);
    const { rules, facts } = context(b);
    const choice = typeof b.choice === "string" ? b.choice : "";
    if (!d.options.some((o) => o.key === choice)) throw new BadRequest("choice is not an option of this decision");
    const reason = cleanText(b.reason, MAX_REASON_CHARS, "reason");
    const waitingIds = Array.isArray(b.waiting) ? b.waiting.filter((x): x is string => typeof x === "string") : [];
    const waiting = waitingIds.map((id) => byId.get(id)).filter((x): x is Decision => Boolean(x) && x!.id !== d.id);
    // The prompt lists every other decision, not just the ones still waiting, so its wording (and so a
    // recorded answer) does not depend on what the visitor happened to answer first; code then keeps
    // only suggestions that are actually waiting.
    const others = decisions.filter((x) => x.id !== d.id);
    const { out, source } = await factFor(env, canSpend, d, choice, reason, rules, facts, others);
    // Re-route candidates: decisions sharing a topic tag with this one, plus the model's suggestions,
    // limited to known waiting ids and capped, so one fact costs a bounded number of calls.
    const known = new Set(waiting.map((w) => w.id));
    const byTag = waiting.filter((w) => w.tags.some((t) => d.tags.includes(t))).map((w) => w.id);
    const suggested = out.may_affect.filter((id) => known.has(id));
    const reroute = out.kind === "none" ? [] : [...new Set([...suggested, ...byTag])].slice(0, MAX_REROUTES_PER_FACT);
    return json({ ...out, may_affect: suggested, reroute, source });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
