// The owner's live queue on the page (docs/STAGE-7.md). The server is the source of truth: the queue,
// the rules and facts, and what is set aside are loaded from it on every page load, and every outcome
// is delivered to the asking session with an awaited call at the moment it is decided. If a delivery
// fails, the card says so and stays open for another press; nothing is queued in the browser.
// Everything here does nothing on the simulation's page.

import type { PuntKind } from "../shared/punt";
import type { Card, Decision } from "../shared/types";
import { api } from "./api";
import { OWNER_PAGE } from "./livemode";
import { type Queue, S } from "./state";

export { OWNER_PAGE };

/** What the asking session is told (the Worker's Resolution). */
export interface Delivery {
  outcome: "option" | "other" | "rejected" | "set-aside" | "reopened" | "resumed";
  choice?: string;
  course?: string;
  reason?: string;
  conditions?: string;
  instruction?: string;
  guidance?: string;
  kind?: string;
}

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

/**
 * The decisions the page can open: the waiting ones, plus any answered in the last day that this
 * browser answered itself (so its own follow-up, a late reason or guidance, still has its decision).
 * One answered elsewhere is closed here.
 */
export function ownerDecisions(q: Queue, answeredHere: Record<string, unknown>): Decision[] {
  return [...q.decisions, ...(q.answered ?? []).filter((r) => answeredHere[r.decision.id]).map((r) => r.decision)];
}

/** After the queue loads: the server's rules, facts, cards and set-aside list replace whatever this browser saved. */
export function startOwner(q: Queue): void {
  if (!OWNER_PAGE) return;
  S.rules = q.rules;
  S.facts = q.facts;
  // A ticket the server says is waiting is waiting, whatever this browser once answered (it was set
  // aside and resumed elsewhere, say): its old answer and finished follow-up go.
  for (const d of q.decisions) {
    if (!S.answered[d.id]) continue;
    delete S.answered[d.id];
    if (S.flows[d.id] && S.flows[d.id].phase !== "choose") delete S.flows[d.id];
  }
  const recent = (q.answered ?? []).filter((r) => S.answered[r.decision.id]);
  const known = new Set([...q.decisions.map((d) => d.id), ...recent.map((r) => r.decision.id)]);
  for (const c of [...q.cards, ...recent.map((r) => r.card)] as Card[]) S.cards[c.id] = c;
  for (const id of Object.keys(S.flows)) if (!known.has(id)) delete S.flows[id];
  S.punts = Object.fromEntries((q.aside ?? []).map((a) => [a.id, { id: a.id, kind: a.kind as PuntKind, reason: a.reason, instruction: a.instruction, at: a.at }]));
  S.reopened = S.reopened.filter((id) => known.has(id));
}

/** Tell the asking session what was decided. Resolves once the Worker has it; throws if it couldn't. No-op off /me. */
export async function deliver(id: string, d: Delivery): Promise<void> {
  if (!OWNER_PAGE) return;
  await api("/api/me/resolve", { id, ...d });
}

/** Save the owner's rules and facts on the server. Resolves once it has them; throws if it couldn't. No-op off /me. */
export async function saveContext(rules: typeof S.rules, facts: typeof S.facts): Promise<void> {
  if (!OWNER_PAGE) return;
  await api("/api/me/context", { rules, facts });
}

/** Why a delivery failed, in words for the card. */
export function deliveryProblem(e: unknown): string {
  return `Couldn't reach the asking session (${(e as Error).message}). Nothing was sent; press again to retry.`;
}
