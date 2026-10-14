// Walk me through it (docs/STAGE-9.md): short numbered steps for one "You first" item. The model
// writes them; code checks them. The input is canonical (no ids, times or setup fields), so a recorded
// walk for a demo brief matches every fresh draft of the same task.
import type { Brief, Catalog } from "./dispatch";

export const MAX_WALK_STEPS = 5;
export const MAX_STEP_CHARS = 140;

/** Everything a walk depends on, and nothing else. */
export interface WalkInput {
  what: string;
  why: string;
  headline: string;
  goal: string;
  /** The tools the task needs, by name. */
  tools: string[];
}

export interface WalkStep {
  text: string;
  /** An https link with no credentials in it, if the step has a page to open. */
  url?: string;
}

export class WalkError extends Error {}

export function walkInput(b: Pick<Brief, "prerequisites" | "headline" | "goal" | "tools_needed">, item: number, c: Catalog): WalkInput {
  const p = b.prerequisites[item];
  if (!p) throw new WalkError("no such item");
  const name = (prefix: string) => c.servers.find((s) => s.prefix === prefix)?.name ?? prefix.replace(/^mcp__/, "");
  return { what: p.what, why: p.why, headline: b.headline, goal: b.goal, tools: b.tools_needed.map(name).filter((n) => n !== "bugme").sort() };
}

export const WALK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "url"],
        properties: { text: { type: "string" }, url: { type: "string", description: "An https link for this step, or an empty string" } },
      },
    },
  },
} as const;

/** An https URL with a host and no user:password part; anything else is dropped, not fixed. */
export function safeLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** Steps that ask the person to paste a secret into a chat or into Bug Me are refused outright. */
const PASTE_HERE = /\b(paste|send|share|give)\b[^.]*\b(it|token|key|secret|password)\b[^.]*\b(here|to me|to bug me|into (this|the) chat|in (this|the) chat)\b/i;

export function parseWalk(raw: unknown): WalkStep[] {
  const steps = (raw as { steps?: unknown })?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new WalkError("no steps");
  const out = steps.slice(0, MAX_WALK_STEPS).map((s): WalkStep => {
    const o = (s ?? {}) as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim().slice(0, MAX_STEP_CHARS) : "";
    if (!text) throw new WalkError("a step has no text");
    if (PASTE_HERE.test(text)) throw new WalkError("a step asks for a secret to be pasted here");
    const url = safeLink(o.url);
    return url ? { text, url } : { text };
  });
  return out;
}

/** The stand-in for tests: generic steps, no model. */
export function fakeWalk(w: WalkInput): { steps: { text: string; url: string }[] } {
  return {
    steps: [
      { text: `Open the settings for ${w.tools[0] ?? "the service"}.`, url: "" },
      { text: `Do this: ${w.what}.`, url: "" },
      { text: "Keep any key in your password manager or keychain, not in a chat.", url: "" },
      { text: "Tick the box in Bug Me when it's done.", url: "" },
    ],
  };
}
