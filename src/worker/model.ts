// Where every model answer comes from, in order of preference:
//
//   1. the deterministic fake, when FAKE_MODEL is set (tests, local runs without a key);
//   2. the recorded run packaged with the Worker, on an exact match of the request;
//   3. the Worker's response cache, on an exact match of an earlier live answer;
//   4. a live call to Claude, after reserving its worst case against the daily cap.
//
// When none of these can answer, ModelUnavailable is thrown and the page shows "couldn't evaluate
// this change" for that card instead of substituting anything.

import Anthropic from "@anthropic-ai/sdk";
import recorded from "../../fixtures/captures/recorded.json";
import { EFFORT, MAX_TOKENS, MODEL, PRICE_PER_MTOK, RESERVE_PER_CALL_USD, TITLE_MAX_TOKENS, TITLE_MODEL, TITLE_PRICE_PER_MTOK } from "../shared/constants";
import { type ConvTurn, type ConverseResult, type Next, advance, sanitizeLedger } from "../shared/converse";
import { fakeConverse } from "../shared/fakeConverse";
import { type Titles, fakeTitles, parseTitles } from "../shared/titles";
import { fakeAsk, fakeFact, fakeRoute } from "../shared/fakeModel";
import { fakeParse, parseParseOutput } from "../shared/parse";
import { modelCacheKey } from "../shared/hash";
import {
  ASK_SCHEMA,
  CONVERSE_PROMPT_VERSION,
  type ConverseCard,
  FACT_SCHEMA,
  PARSE_PROMPT_VERSION,
  PROMPT_VERSION,
  TITLE_PROMPT_VERSION,
  askPrompt,
  conversePrompt,
  converseSchema,
  factPrompt,
  parsePrompt,
  parseSchema,
  routePrompt,
  routeSchema,
  titlePrompt,
  titleSchema,
} from "../shared/prompts";
import { parseAskOutput } from "../shared/ask";
import { parseRouteOutput } from "../shared/route";
import { parseFactOutput } from "../shared/fact";
import type { AskOutput, Decision, Fact, FactOutput, ParseOutput, RouteOutput, Rule, Source } from "../shared/types";
import { persona } from "./data";
import type { SpendCounter } from "./spend";

export interface Env {
  ASSETS: Fetcher;
  SPEND: DurableObjectNamespace<SpendCounter>;
  SEAL_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Any non-empty value switches every model call to the deterministic fake. */
  FAKE_MODEL?: string;
  /** Turnstile keys. With TURNSTILE_SECRET set, live calls need a session token (session.ts). */
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  /** Per-IP rate limiter on the paid endpoints (wrangler.jsonc "ratelimits"); absent locally. */
  LIMITER?: RateLimit;
}

/** Timeout for one live call, in milliseconds. A low-effort routed card measured well under this. */
const LIVE_TIMEOUT_MS = 45_000;

export class ModelUnavailable extends Error {}

/** A live call is needed and the visitor has no valid session yet: the page runs Turnstile and retries. */
export class NeedsSession extends Error {}

interface RecordedEntry {
  output: unknown;
}
const RECORDED = (recorded as { entries: Record<string, RecordedEntry> }).entries;

function priceOf(u: Anthropic.Usage, price: typeof PRICE_PER_MTOK): number {
  return (
    (u.input_tokens * price.input +
      u.output_tokens * price.output +
      (u.cache_read_input_tokens ?? 0) * price.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

/** Which model a call uses. Everything but the titles uses MODEL; the titles use the fast model. */
interface CallModel {
  model: string;
  maxTokens: number;
  price: typeof PRICE_PER_MTOK;
}
const MAIN: CallModel = { model: MODEL, maxTokens: MAX_TOKENS, price: PRICE_PER_MTOK };
const FAST: CallModel = { model: TITLE_MODEL, maxTokens: TITLE_MAX_TOKENS, price: TITLE_PRICE_PER_MTOK };

function cacheUrl(key: string): string {
  // The Cache API needs a URL; this one is never fetched, it only names the entry.
  return `https://bugme-cache.invalid/${key}`;
}

/**
 * Ask the model (or a stored answer to the identical request) for JSON matching `schema`, checked by
 * `validate` before it is returned or cached, so a malformed live answer is never stored.
 */
async function ask<T>(
  env: Env,
  canSpend: boolean,
  prompt: string,
  schema: object,
  validate: (raw: unknown) => T,
  promptVersion: string = PROMPT_VERSION,
  m: CallModel = MAIN,
): Promise<{ out: T; source: Source }> {
  const key = await modelCacheKey({ model: m.model, effort: EFFORT, maxTokens: m.maxTokens, promptVersion, schema, prompt });
  const rec = RECORDED[key];
  if (rec) return { out: validate(rec.output), source: "recorded" };

  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(cacheUrl(key));
  if (hit) {
    try {
      return { out: validate(await hit.json()), source: "cached" };
    } catch {
      await cache.delete(cacheUrl(key)); // stored before validation existed or under an older parser
    }
  }

  if (!env.ANTHROPIC_API_KEY) throw new ModelUnavailable("no API key configured; only recorded answers are available");
  if (!canSpend) throw new NeedsSession("a quick human check is needed before live calls");
  const counter = env.SPEND.get(env.SPEND.idFromName("global"));
  const r = await counter.reserve(RESERVE_PER_CALL_USD);
  if (!r.ok) throw new ModelUnavailable(`today's live budget ($${r.state.cap}) is spent`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: LIVE_TIMEOUT_MS });
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.create({
      model: m.model,
      max_tokens: m.maxTokens,
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    console.error("live call failed", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
    throw new ModelUnavailable("the live model call failed");
  }
  await counter.reconcile(r.state.day, RESERVE_PER_CALL_USD, priceOf(msg.usage, m.price));
  if (msg.stop_reason === "refusal") throw new ModelUnavailable("the model declined this request");
  if (msg.stop_reason === "max_tokens") throw new ModelUnavailable("the model's answer was cut off");
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  let raw: unknown;
  let out: T;
  try {
    raw = JSON.parse(text);
    out = validate(raw);
  } catch (e) {
    console.error("live answer rejected", e instanceof Error ? e.message : e);
    throw new ModelUnavailable("the model's answer did not pass validation");
  }
  await cache.put(cacheUrl(key), new Response(JSON.stringify(raw), { headers: { "cache-control": "max-age=604800" } }));
  return { out, source: "live" };
}

export async function routeFor(env: Env, canSpend: boolean, d: Decision, rules: Rule[], facts: Fact[]): Promise<{ out: RouteOutput; source: Source }> {
  if (env.FAKE_MODEL) return { out: fakeRoute(d, rules, facts), source: "code" };
  return ask(env, canSpend, routePrompt(persona, rules, facts, d), routeSchema(d.options.map((o) => o.key)), (raw) => parseRouteOutput(raw, d));
}

export async function factFor(
  env: Env,
  canSpend: boolean,
  d: Decision,
  choice: string,
  reason: string,
  rules: Rule[],
  facts: Fact[],
  waiting: Decision[],
  outside?: { kind: "other" | "rejected"; course: string },
): Promise<{ out: FactOutput; source: Source }> {
  if (env.FAKE_MODEL) return { out: fakeFact(d, reason, waiting, facts), source: "code" };
  return ask(env, canSpend, factPrompt(persona, rules, facts, d, choice, reason, waiting, outside), FACT_SCHEMA, (raw) => parseFactOutput(raw, facts));
}

export async function askFor(env: Env, canSpend: boolean, d: Decision, question: string): Promise<{ out: AskOutput; source: Source }> {
  if (env.FAKE_MODEL) return { out: fakeAsk(d, question), source: "code" };
  return ask(env, canSpend, askPrompt(persona, d, question), ASK_SCHEMA, parseAskOutput);
}

export async function parseFor(env: Env, canSpend: boolean, d: Decision, text: string): Promise<{ out: ParseOutput; source: Source }> {
  if (env.FAKE_MODEL) return { out: fakeParse(d, text), source: "code" };
  const keys = d.options.map((o) => o.key);
  return ask(env, canSpend, parsePrompt(persona, d, text), parseSchema(keys), (raw) => parseParseOutput(raw, d, text), PARSE_PROMPT_VERSION);
}

/**
 * One turn of the decision conversation: the model's reading of the thread, checked (quotes verified
 * by turn, other/reject need a course) and then put through `advance`, which decides what happens next.
 * The validator runs the same checks, so a reply that fails them is never cached.
 */
export async function converseFor(
  env: Env,
  canSpend: boolean,
  d: Decision,
  card: ConverseCard,
  turns: ConvTurn[],
  rules: Rule[],
  facts: Fact[],
): Promise<{ out: ConverseResult; source: Source }> {
  const finish = (raw: unknown): ConverseResult => {
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    const o = raw as Record<string, unknown>;
    const next = o.next;
    if (next !== "ask" && next !== "confirm" && next !== "close") throw new Error("next is not ask, confirm or close");
    return advance(d, turns, typeof o.reply === "string" ? o.reply : "", next as Next, sanitizeLedger(o.ledger, d, turns));
  };
  if (env.FAKE_MODEL) return { out: finish(fakeConverse(d, turns)), source: "code" };
  const keys = d.options.map((o) => o.key);
  return ask(env, canSpend, conversePrompt(persona, rules, facts, d, card, turns), converseSchema(keys), finish, CONVERSE_PROMPT_VERSION);
}

/** A decision's emoji, title and "done" lines, from the fast model. */
export async function titlesFor(env: Env, canSpend: boolean, d: Decision): Promise<{ out: Titles; source: Source }> {
  if (env.FAKE_MODEL) return { out: fakeTitles(d), source: "code" };
  return ask(env, canSpend, titlePrompt(d), titleSchema(d.options.map((o) => o.key)), (raw) => parseTitles(raw, d), TITLE_PROMPT_VERSION, FAST);
}
