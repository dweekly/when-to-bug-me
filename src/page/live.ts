// The owner's live queue on the page (docs/STAGE-7.md): signing in with the one-time link, keeping the
// owner's rules and facts on the server, delivering each answer back to the session that asked, and
// noticing new asks. Everything here does nothing on the simulation's page.

import type { PuntKind } from "../shared/punt";
import { api } from "./api";
import { OWNER_PAGE } from "./livemode";
import { S, onSave, save } from "./state";

/** What the asking session is told (the Worker's Resolution). */
export interface Delivery {
  outcome: "option" | "other" | "rejected" | "ask-agent" | "set-aside" | "reopened" | "resumed";
  choice?: string;
  course?: string;
  reason?: string;
  conditions?: string;
  questions?: string[];
  instruction?: string;
  guidance?: string;
  kind?: string;
}

/** A ticket set aside on any device, as /api/me/queue lists it. */
export interface Aside {
  id: string;
  kind: string;
  reason: string;
  instruction: string;
  at: string;
}

/** Undelivered answers, kept in this browser until the Worker has them, so a lost request isn't a lost answer. */
const OUTBOX_KEY = "bugme.live.outbox";
const RETRY_MS = 15_000;
/** How often an open, visible page looks for new asks. */
const REFRESH_MS = 60_000;

/**
 * Sign in from the link `/me#k=<token>`: the token is in the fragment, so it never reaches the server's
 * logs; it is cleared from the address bar first, then posted once for the owner cookie.
 */
export async function signIn(): Promise<void> {
  if (!OWNER_PAGE || !location.hash.startsWith("#k=")) return;
  const k = decodeURIComponent(location.hash.slice(3));
  history.replaceState(null, "", "/me#/");
  const res = await fetch("/api/me/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ k }) });
  if (!res.ok) throw new Error("That sign-in link isn't valid.");
}

let lastContext = "";

/**
 * After the queue loads: the server's rules, facts and set-aside list win (so desktop and phone agree),
 * later rule and fact edits are saved back, undelivered answers are retried, and new asks are noticed.
 */
export function startOwner(rules: typeof S.rules, facts: typeof S.facts, ids: string[], aside: Aside[]): void {
  if (!OWNER_PAGE) return;
  S.rules = rules;
  S.facts = facts;
  // A ticket resolved on another device has left the queue: drop what this browser still holds about it.
  const known = new Set(ids);
  for (const id of Object.keys(S.punts)) if (!known.has(id)) delete S.punts[id];
  for (const id of Object.keys(S.flows)) if (!known.has(id)) delete S.flows[id];
  for (const a of aside) S.punts[a.id] ??= { id: a.id, kind: a.kind as PuntKind, reason: a.reason, instruction: a.instruction, at: a.at };
  save();
  lastContext = JSON.stringify([rules, facts]);
  onSave(() => {
    const now = JSON.stringify([S.rules, S.facts]);
    if (now === lastContext) return;
    lastContext = now;
    void api("/api/me/context", { rules: S.rules, facts: S.facts }).catch((e) => console.warn("Bug Me: couldn't save your rules", e));
  });
  void flush();
  watchForAsks(known);
}

function outbox(): { id: string; d: Delivery }[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function setOutbox(items: { id: string; d: Delivery }[]): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable: delivery is still attempted, just not kept across a reload */
  }
  document.body.dataset.undelivered = String(items.length);
}

let flushing = false;
let retry: ReturnType<typeof setTimeout> | undefined;

/** Send what's waiting, in order. Resolving is idempotent, so a request that landed but lost its reply is safe to resend. */
async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const [first] = outbox();
      if (!first) break;
      try {
        await api("/api/me/resolve", { id: first.id, ...first.d });
      } catch (e) {
        // An unknown ticket will never succeed (resolved and pruned elsewhere): drop it rather than retry forever.
        if (/unknown ticket/.test(String((e as Error).message))) {
          setOutbox(outbox().slice(1));
          continue;
        }
        console.warn("Bug Me: couldn't deliver the answer yet; retrying", e);
        clearTimeout(retry);
        retry = setTimeout(() => void flush(), RETRY_MS);
        break;
      }
      setOutbox(outbox().slice(1));
    }
  } finally {
    flushing = false;
  }
}

/** Tell the asking session what was decided. Kept until delivered; a later delivery adds to an earlier one. */
export function deliver(id: string, d: Delivery): void {
  if (!OWNER_PAGE) return;
  setOutbox([...outbox(), { id, d }]);
  void flush();
}

/**
 * A page left open doesn't hear about new asks by itself: when it is visible on Home or Decided for you
 * (never mid-card, so no draft is disturbed), it checks the queue and reloads if the asks changed.
 */
function watchForAsks(known: Set<string>): void {
  const check = async () => {
    if (document.visibilityState !== "visible" || !/^#\/(settled)?$|^$/.test(location.hash)) return;
    try {
      const q = await api<{ decisions: { id: string }[] }>("/api/queue");
      const ids = new Set(q.decisions.map((d) => d.id));
      if (ids.size !== known.size || [...ids].some((id) => !known.has(id))) location.reload();
    } catch {
      /* offline or signed out: try again next time */
    }
  };
  document.addEventListener("visibilitychange", () => void check());
  setInterval(() => void check(), REFRESH_MS);
}
