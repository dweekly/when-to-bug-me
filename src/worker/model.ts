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
import { EFFORT, MAX_TOKENS, MODEL, PRICE_PER_MTOK, RESERVE_PER_CALL_USD } from "../shared/constants";
import { fakeAsk, fakeFact, fakeRoute } from "../shared/fakeModel";
import { modelCacheKey } from "../shared/hash";
import { ASK_SCHEMA, FACT_SCHEMA, PROMPT_VERSION, routeSchema, askPrompt, factPrompt, routePrompt } from "../shared/prompts";
import { parseAskOutput } from "../shared/ask";
import { parseRouteOutput } from "../shared/route";
import { parseFactOutput } from "../shared/fact";
import type { AskOutput, Decision, Fact, FactOutput, RouteOutput, Rule, Source } from "../shared/types";
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

function priceOf(u: Anthropic.Usage): number {
  return (
    (u.input_tokens * PRICE_PER_MTOK.input +
      u.output_tokens * PRICE_PER_MTOK.output +
      (u.cache_read_input_tokens ?? 0) * PRICE_PER_MTOK.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * PRICE_PER_MTOK.cacheWrite) /
    1_000_000
  );
}

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
): Promise<{ out: T; source: Source }> {
  const key = await modelCacheKey({ model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, promptVersion: PROMPT_VERSION, schema, prompt });
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
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    console.error("live call failed", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
    throw new ModelUnavailable("the live model call failed");
  }
  await counter.reconcile(r.state.day, RESERVE_PER_CALL_USD, priceOf(msg.usage));
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
): Promise<{ out: FactOutput; source: Source }> {
  if (env.FAKE_MODEL) return { out: fakeFact(d, reason, waiting, facts), source: "code" };
  return ask(env, canSpend, factPrompt(persona, rules, facts, d, choice, reason, waiting), FACT_SCHEMA, (raw) => parseFactOutput(raw, facts));
}

export async function askFor(env: Env, canSpend: boolean, d: Decision, question: string): Promise<{ out: AskOutput; source: Source }> {
  if (env.FAKE_MODEL) return { out: fakeAsk(d, question), source: "code" };
  return ask(env, canSpend, askPrompt(persona, d, question), ASK_SCHEMA, parseAskOutput);
}
