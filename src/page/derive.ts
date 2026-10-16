// Views derived from state without touching the DOM: a decision's current route, the agenda, which
// decisions are still waiting, and the labels shown for routes and for where a card came from.

import { buildAgenda } from "../shared/agenda";
import type { RouteKind, Source } from "../shared/types";
import { Q, S, isCard, talking } from "./state";
import { isMirror } from "./mirror";

/** What Bug Me brings you to decide: mirrored questions are answered in their sessions, so they sit apart. */
const decidable = () => Q.decisions.filter((d) => !isMirror(d.id));

export const ROUTE_LABEL: Record<RouteKind, string> = { settle: "Settled for you", check_in: "Quick check-in", decide: "Your decision" };
/** Routes as symbols: handled for you, a quick check, needs you. */
export const GLYPH: Record<RouteKind, string> = { settle: "○", check_in: "◐", decide: "●" };
// Plain words for where model output came from (issue #66): a visitor shouldn't need the README to read them.
export const SOURCE_LABEL: Record<Source, string> = { live: "Claude, live", cached: "Claude, cached", recorded: "Claude, recorded earlier", code: "code stand-in" };
/** What each source means, for a tooltip. */
export const SOURCE_HINT: Record<Source, string> = {
  live: "Real Claude output, asked just now.",
  cached: "Real Claude output, saved from an earlier identical request.",
  recorded: "Real Claude output, recorded once and replayed here for free (no live call).",
  code: "Written by code, not Claude: a deterministic stand-in.",
};

export function routeOf(id: string): RouteKind | null {
  const c = S.cards[id];
  if (!isCard(c)) return null;
  // Undone or set aside: never settled automatically again, even if a re-route says it could be.
  if ((S.reopened.includes(id) || S.punts[id]) && c.route === "settle") return "check_in";
  return c.route;
}

export function routesForAgenda(): Record<string, RouteKind> {
  const r: Record<string, RouteKind> = {};
  for (const d of decidable()) {
    const k = routeOf(d.id);
    if (k) r[d.id] = k;
  }
  return r;
}

export function agenda() {
  return buildAgenda(decidable(), routesForAgenda(), Q.persona.projects, new Set(Object.keys(S.answered)), new Set(Object.keys(S.punts)));
}

/** Decisions still the person's whose route never came back (issue #55). They are never dropped from
 *  view: Home lists them with a retry, and nothing says "All clear" while any remain. */
export function unroutedIds(): string[] {
  return decidable().filter((d) => !S.answered[d.id] && !S.punts[d.id] && !isCard(S.cards[d.id])).map((d) => d.id);
}

/** Decisions not yet answered by the person, including ones Bug Me settled: all can be re-routed. */
export function waitingIds(): string[] {
  return decidable().filter((d) => !S.answered[d.id]).map((d) => d.id);
}

/** What guidance may re-route: waiting decisions, except one the person is in a conversation about
 *  (it must not move into Decided for you under them). */
export function reroutableIds(): string[] {
  return waitingIds().filter((id) => !talking(id));
}

export function firstAgendaId(): string | null {
  const a = agenda();
  for (const s of a.sections) {
    const first = s.decisions[0] ?? s.check_ins[0];
    if (first) return first.id;
  }
  return null;
}
