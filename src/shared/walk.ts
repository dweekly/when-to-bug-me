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

/**
 * A safety net, not a guarantee: a step that hands a secret to Bug Me, a chat or the session is refused
 * (an action word, a secret, and one of those destinations in the same step). No keyword list catches
 * every phrasing, so the page also says, under every walk, that Bug Me never needs a secret, and the
 * prompt tells the model where secrets go. Storing a key in a password manager, the keychain or a
 * tool's own config says none of these, and passes.
 */
const HAND_OVER = /\b(paste|put|send|share|give|type|enter|provide|copy|upload|submit|drop|add|insert)\b/i;
const SECRET_WORD = /\b(token|key|secret|password|passphrase|credential)s?\b/i;
const TO_US = /\bbug me\b|\bchat\b|\bhere\b|\b(this|the|your|claude code) session\b|\b(send|give|tell|show) me\b/i;
const handsOver = (text: string) => HAND_OVER.test(text) && SECRET_WORD.test(text) && TO_US.test(text);

export function parseWalk(raw: unknown): WalkStep[] {
  const steps = (raw as { steps?: unknown })?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new WalkError("no steps");
  const out = steps.slice(0, MAX_WALK_STEPS).map((s): WalkStep => {
    const o = (s ?? {}) as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim().slice(0, MAX_STEP_CHARS) : "";
    if (!text) throw new WalkError("a step has no text");
    if (handsOver(text)) throw new WalkError("a step asks for a secret to be handed over");
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
