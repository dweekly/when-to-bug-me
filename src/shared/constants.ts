// Every tunable number in the prototype, with where it came from. Heuristics are marked as such;
// change them here, nowhere else.

/** The model every live call uses. Verified against the Models table in the claude-api skill (cached 2026-10-06). */
export const MODEL = "claude-opus-5-5";

/** Effort for both prompts. Low matches the bench predictor these prompts were ported from. */
export const EFFORT = "low" as const;

/** Output ceiling per call. A routed card is about 400 output tokens plus low-effort thinking; this leaves headroom. */
export const MAX_TOKENS = 4000;

/**
 * Price per million tokens for MODEL, in US dollars (claude-api skill, Current Models table, cached
 * 2026-10-06: Opus 5.5 is $4 input / $20 output, cache reads $0.20). Used to price each response from
 * its own usage block for the daily spend counter.
 */
export const PRICE_PER_MTOK = { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 };

/** Daily ceiling on live model spend for the whole deployment (build plan, "Cost and abuse controls"). */
export const DAILY_SPEND_CAP_USD = 10;

/**
 * Worst-case cost reserved before a live call is allowed, so concurrent calls cannot overshoot the cap
 * by much. Heuristic: an 8k-token prompt plus MAX_TOKENS of output at PRICE_PER_MTOK is about $0.11.
 */
export const RESERVE_PER_CALL_USD = 0.12;

/**
 * Bug Me asks "I'm curious: why?" when the answer goes against a guess at least this confident.
 * Heuristic, chosen so that a near coin-flip guess being wrong does not trigger the question.
 */
export const WHY_THRESHOLD = 0.6;

/** At most this many pushbacks per session. Heuristic; the proposal says pushback is rationed. */
export const MAX_PUSHBACKS_PER_SESSION = 2;

/** Agenda time estimates, in minutes. Heuristic, used only for the "about N minutes" line. */
export const MINUTES_PER_CHECK_IN = 1;
export const MINUTES_PER_DECISION = 3;

/** Input caps, in characters, for anything a visitor types that reaches a model. */
export const MAX_REASON_CHARS = 600;
export const MAX_RULE_CHARS = 240;
export const MAX_RULES = 20;
export const MAX_FACTS = 30;

/** A stated reason shorter than this is treated as no basis at all (for the firefly). Heuristic. */
export const MIN_BASIS_CHARS = 12;

/**
 * Bug Me may settle an option alone only if its hand-authored cost is at or under this. Heuristic: an
 * amount small enough that a wrong call is not worth an interruption.
 */
export const SETTLE_MAX_COST_USD = 50;

/** At most this many decisions are re-routed after one piece of kept guidance. Bounds cost per interaction. */
export const MAX_REROUTES_PER_FACT = 6;

/** Concurrent model calls when re-routing several decisions at once. */
export const REROUTE_CONCURRENCY = 4;

/** Most pros, and most cons, shown under one option: enough to see the trade-off at a glance. Heuristic. */
export const MAX_OPTION_NOTES = 2;

/** How long the Undo bar stays after clicking an option, before the answer is sent. Long enough to
 *  catch a misclick, short enough that the next card isn't kept waiting. Heuristic. */
export const UNDO_WINDOW_MS = 4000;

/** Consecutive speech-service failures (network and the like) before voice stops and says so. Heuristic. */
export const VOICE_MAX_FAILURES = 3;

/** Wait before retrying after a speech-service failure, in ms, multiplied by the failure count. Heuristic. */
export const VOICE_RETRY_BASE_MS = 1000;

/** Longest wait for a phrase in progress to finish before an answer is sent, in ms. Heuristic: the
 *  speech service usually delivers its final words well within this after being asked to stop. */
export const VOICE_DRAIN_MS = 1500;
