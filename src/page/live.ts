// The owner's live queue on the page (docs/STAGE-7.md): signing in with the one-time link, taking the
// owner's state from the server, keeping rules and facts saved there, delivering each answer back to
// the session that asked, and noticing new asks. Everything here does nothing on the simulation's page.

import type { Card, Decision } from "../shared/types";
import type { PuntKind } from "../shared/punt";
import { api } from "./api";
import { OWNER_PAGE } from "./livemode";
import { type Queue, S, onSave, save } from "./state";

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

/** Answered in the last day, as /api/me/queue lists them: not waiting, but their follow-ups still work. */
export interface Recent {
  decision: Decision;
  card: Card;
}

interface Item {
  uid: string;
  id: string;
  d: Delivery;
}

/** Undelivered answers. The working copy is in memory; localStorage keeps it across a reload when it can. */
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

/** Every decision the page may need by id: the waiting ones, and those answered in the last day. */
export function ownerDecisions(q: Queue): Decision[] {
  return [...q.decisions, ...((q.answered ?? []) as Recent[]).map((r) => r.decision)];
}

/**
 * After the queue loads, the server is the source of truth: rules and facts, every card (unless an
 * answer in progress has frozen its own), and the set-aside list. This browser keeps only what is
 * still its own: drafts, unfinished follow-ups, and deliveries not yet acknowledged.
 */
export function startOwner(q: Queue): void {
  if (!OWNER_PAGE) return;
  S.rules = q.rules;
  S.facts = q.facts;
  const recent = (q.answered ?? []) as Recent[];
  const known = new Set(ownerDecisions(q).map((d) => d.id));
  for (const c of [...q.cards, ...recent.map((r) => r.card)]) if (!S.flows[c.id]?.card) S.cards[c.id] = c;
  for (const id of Object.keys(S.flows)) if (!known.has(id)) delete S.flows[id];
  const aside = new Map((q.aside ?? []).map((a) => [a.id, a]));
  const pendingAside = new Set(mem.filter((i) => i.d.outcome === "set-aside").map((i) => i.id));
  for (const id of Object.keys(S.punts)) if (!aside.has(id) && !pendingAside.has(id)) delete S.punts[id];
  for (const a of aside.values()) S.punts[a.id] = { id: a.id, kind: a.kind as PuntKind, reason: a.reason, instruction: a.instruction, at: a.at };
  save();
  synced = JSON.stringify([q.rules, q.facts]);
  onSave(() => void saveContext());
  void flush();
  watchForAsks(new Set(q.decisions.map((d) => d.id)));
}

// ---------- Rules and facts ----------

/** The rules and facts the server is known to hold; anything else in the page is still to be saved. */
let synced = "";
let contextRetry: ReturnType<typeof setTimeout> | undefined;

async function saveContext(): Promise<void> {
  const now = JSON.stringify([S.rules, S.facts]);
  if (now === synced) return;
  try {
    await api("/api/me/context", { rules: S.rules, facts: S.facts });
    synced = now;
  } catch (e) {
    console.warn("Bug Me: couldn't save your rules yet; retrying", e);
    clearTimeout(contextRetry);
    contextRetry = setTimeout(() => void saveContext(), RETRY_MS);
  }
}

// ---------- Delivery ----------

function stored(): Item[] {
  try {
    const v = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((i) => i && typeof i.uid === "string") : [];
  } catch {
    return [];
  }
}

/** The working outbox: what this tab still has to send, merged with what any tab left in storage. */
let mem: Item[] = OWNER_PAGE ? stored() : [];

function persist(): void {
  try {
    // Another tab may have added or acknowledged items: keep its additions, drop what anyone has sent.
    const sent = new Set(acked);
    const byUid = new Map([...stored(), ...mem].filter((i) => !sent.has(i.uid)).map((i) => [i.uid, i]));
    mem = [...byUid.values()];
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(mem));
  } catch {
    /* storage unavailable: delivery still runs from memory, it just won't survive a reload */
  }
  document.body.dataset.undelivered = String(mem.length);
}

/** Items acknowledged by the Worker in this tab, so a merge with storage never brings them back. */
const acked: string[] = [];

let flushing = false;
let retry: ReturnType<typeof setTimeout> | undefined;

/** Send what's waiting, in order. Resolving is idempotent, so a request that landed but lost its reply is safe to resend. */
async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    persist();
    while (mem.length) {
      const item = mem[0];
      try {
        await api("/api/me/resolve", { id: item.id, ...item.d });
      } catch (e) {
        const msg = String((e as Error).message);
        // A request the Worker refuses outright (an unknown ticket, a malformed answer) will never succeed:
        // drop it, so it can't hold up every answer behind it. Anything else is retried.
        if (/unknown ticket|must be|is not an option|is required/.test(msg)) {
          console.warn("Bug Me: an answer couldn't be delivered and was dropped:", msg);
        } else {
          console.warn("Bug Me: couldn't deliver an answer yet; retrying", e);
          clearTimeout(retry);
          retry = setTimeout(() => void flush(), RETRY_MS);
          break;
        }
      }
      acked.push(item.uid);
      mem = mem.filter((i) => i.uid !== item.uid);
      persist();
    }
  } finally {
    flushing = false;
  }
}

/** Tell the asking session what was decided. Kept until delivered; a later delivery adds to an earlier one. */
export function deliver(id: string, d: Delivery): void {
  if (!OWNER_PAGE) return;
  mem.push({ uid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, id, d });
  persist();
  void flush();
}

// ---------- New asks ----------

/** Home and Decided for you: views with no draft to lose. */
const quietView = () => document.visibilityState === "visible" && /^(#\/(settled)?)?$/.test(location.hash);

/**
 * A page left open doesn't hear about new asks by itself: when it is visible on Home or Decided for you,
 * it checks the queue and reloads if the asks changed (checking the view again just before, since the
 * person may have opened a card while the check was out).
 */
function watchForAsks(known: Set<string>): void {
  const check = async () => {
    if (!quietView()) return;
    try {
      const q = await api<{ decisions: { id: string }[] }>("/api/queue");
      const ids = new Set(q.decisions.map((d) => d.id));
      const changed = ids.size !== known.size || [...ids].some((id) => !known.has(id));
      if (changed && quietView()) location.reload();
    } catch {
      /* offline or signed out: try again next time */
    }
  };
  document.addEventListener("visibilitychange", () => void check());
  setInterval(() => void check(), REFRESH_MS);
}
