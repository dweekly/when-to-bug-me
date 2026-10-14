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
 * Rechecked for stage 6: the largest conversation prompt (six full turns) stays under 24,000 characters,
 * about 8k tokens (tests/unit/converse.test.ts), so the reservation is unchanged. A title call on the
 * fast model reserves the same and reconciles to its real cost, a small fraction of a cent.
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

/** Most marks one parse may return: enough for a choice, reasons, a condition and a question. Heuristic. */
export const MAX_MARKS = 8;

/** Quiet time after typing stops before the text is parsed, in ms. Heuristic: a pause, not a keystroke gap. */
export const PARSE_TYPING_IDLE_MS = 1200;

/** Longest Send waits for the parse of the final words, in ms, before answering without it. Heuristic. */
export const PARSE_SEND_WAIT_MS = 5000;

/** Consecutive speech-service failures (network and the like) before voice stops and says so. Heuristic. */
export const VOICE_MAX_FAILURES = 3;

/** Wait before retrying after a speech-service failure, in ms, multiplied by the failure count. Heuristic. */
export const VOICE_RETRY_BASE_MS = 1000;

/** Longest wait for a phrase in progress to finish before an answer is sent, in ms. Heuristic: the
 *  speech service usually delivers its final words well within this after being asked to stop. */
export const VOICE_DRAIN_MS = 1500;

/** The conversation (docs/STAGE-6.md). Bug Me asks at most this many elicitation questions per decision;
 *  pushback, the guess reveal and the guidance offer don't count. Heuristic: one why, one follow-up. */
export const MAX_CONVERSE_QUESTIONS = 2;

/** Most of Jordan's turns in one thread, and their total characters; after that only the read-back. */
export const MAX_CONVERSE_TURNS = 6;
export const MAX_TRANSCRIPT_CHARS = 2400;

/** Longest Bug Me reply, in characters: two short sentences. Code trims anything longer. */
export const MAX_REPLY_CHARS = 300;

/** "Huh?" (docs/STAGE-6E.md): presses per thread, which don't count toward MAX_CONVERSE_TURNS, and the
 *  longest re-presentation, which carries context and so runs longer than a normal turn. */
export const MAX_HUH = 2;
export const MAX_EXPLAIN_CHARS = 700;

/** Most characters of Jordan's words (why, conditions, feedback; whole quotes) given to the guidance call. */
export const MAX_EVIDENCE_CHARS = 900;

/**
 * The fast, cheap model that gives each decision an emoji and a short title (David, 2026-10-12).
 * Verified against the claude-api skill's Models table (2026-10-12): Claude Haiku 5.5 is $0.10 input /
 * $0.50 output per million tokens, effort low through max.
 */
export const TITLE_MODEL = "claude-haiku-5-5";
export const TITLE_PRICE_PER_MTOK = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
/** Output ceiling for a title call: an emoji, six words, and a short line per option. */
export const TITLE_MAX_TOKENS = 1000;
/** Most words in a title, or in a settled item's "done" line. */
export const MAX_TITLE_WORDS = 6;

/**
 * The runner (docs/STAGE-9.md). Its default port, picked to stay clear of wrangler's 8787 and the tests'
 * 8799 and 8807; the Worker under it listens on the next port.
 */
export const RUNNER_PORT = 8790;
/**
 * One `claude -p` call through the runner. Under the Worker's own wait for it (LOCAL_TIMEOUT_MS, 180 s in
 * src/worker/model.ts), so the child is killed before the Worker gives up. A brief measured about a minute.
 */
export const RUNNER_MODEL_TIMEOUT_MS = 170_000;
/** The header the runner puts on every request it passes to the Worker under it, carrying its model key. */
export const RUNNER_HEADER = "x-bugme-runner";
/** `claude -p` calls at once: each is a whole session's memory and startup. */
export const RUNNER_MAX_MODEL_CALLS = 2;
/** Starting a background session: `claude --bg` returns once the session exists (measured ~2 s). */
export const RUNNER_LAUNCH_TIMEOUT_MS = 60_000;
/** `claude mcp list` checks each server's health, so it can take a while (sync-catalog allows 180 s). */
export const RUNNER_MCP_LIST_TIMEOUT_MS = 180_000;
/** A reservation older than this with no session is reconciled from `claude agents` before anything else. */
export const RUNNER_STALE_LAUNCH_MS = 2 * 60_000;

/**
 * How often the owner's page looks for new asks and, on the runner, for its sessions' state
 * (docs/STAGE-9.md): often enough that a launched session's question reaches the phone within seconds,
 * and only while the page is visible.
 */
export const OWNER_POLL_MS = 8_000;
