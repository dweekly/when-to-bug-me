// An emoji and a short title for every decision, and per option a past-tense "done" line, from the
// fast model (docs/STAGE-6.md, section 1b). Display only: Home, the thread header, Decided for you.
// Never an input to routing.

import { MAX_TITLE_WORDS } from "./constants";
import type { Decision } from "./types";

export interface Titles {
  emoji: string;
  title: string;
  /** Per option key: what was done, in the past tense, if that option was taken. */
  done: Record<string, string>;
}

export class TitleError extends Error {}

/** Exactly one emoji: one pictographic grapheme (a flag, keycap or joined sequence counts as one). */
export function isOneEmoji(s: string): boolean {
  const segs = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s.trim())];
  return segs.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segs[0].segment);
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Validate a title answer: one emoji; a title and every "done" line of 1 to MAX_TITLE_WORDS words. */
export function parseTitles(raw: unknown, d: Decision): Titles {
  if (!raw || typeof raw !== "object") throw new TitleError("not an object");
  const o = raw as Record<string, unknown>;
  const emoji = typeof o.emoji === "string" ? o.emoji.trim() : "";
  if (!isOneEmoji(emoji)) throw new TitleError(`emoji is not exactly one emoji: ${JSON.stringify(o.emoji)}`);
  const title = typeof o.title === "string" ? o.title.trim().replace(/\.$/, "") : "";
  if (!title || words(title) > MAX_TITLE_WORDS) throw new TitleError(`title is not 1 to ${MAX_TITLE_WORDS} words: ${JSON.stringify(o.title)}`);
  const doneRaw = (o.done && typeof o.done === "object" ? o.done : {}) as Record<string, unknown>;
  const done: Record<string, string> = {};
  for (const opt of d.options) {
    const v = typeof doneRaw[opt.key] === "string" ? (doneRaw[opt.key] as string).trim().replace(/\.$/, "") : "";
    if (!v || words(v) > MAX_TITLE_WORDS) throw new TitleError(`done.${opt.key} is not 1 to ${MAX_TITLE_WORDS} words: ${JSON.stringify(doneRaw[opt.key])}`);
    done[opt.key] = v;
  }
  return { emoji, title, done };
}

/** Tags to an emoji, for the stand-in. */
const TAG_EMOJI: [string, string][] = [
  ["housekeeping", "🧹"],
  ["tests", "🧪"],
  ["dependencies", "📦"],
  ["public-api", "🔌"],
  ["travel", "✈️"],
  ["calendar", "📅"],
  ["money", "💵"],
  ["ui", "🎨"],
];

/** The deterministic stand-in: an emoji from the tags, the question's first words, the option labels. */
export function fakeTitles(d: Decision): Titles {
  const emoji = TAG_EMOJI.find(([t]) => d.tags.includes(t))?.[1] ?? "❓";
  const cut = (s: string) => s.replace(/[?.]/g, "").trim().split(/\s+/).slice(0, MAX_TITLE_WORDS).join(" ");
  return { emoji, title: cut(d.question), done: Object.fromEntries(d.options.map((o) => [o.key, cut(o.label)])) };
}
