// Views derived from state without touching the DOM: a decision's current route, the agenda, which
// decisions are still waiting, and the labels shown for routes and for where a card came from.

import { buildAgenda } from "../shared/agenda";
import type { RouteKind, Source } from "../shared/types";
import { Q, S, isCard } from "./state";

export const ROUTE_LABEL: Record<RouteKind, string> = { settle: "Settled for you", check_in: "Quick check-in", decide: "Your decision" };
export const SOURCE_LABEL: Record<Source, string> = { live: "live Claude", cached: "cached Claude", recorded: "recorded Claude run", code: "code stand-in" };

export function routeOf(id: string): RouteKind | null {
  const c = S.cards[id];
  if (!isCard(c)) return null;
  if (S.reopened.includes(id) && c.route === "settle") return "check_in";
  return c.route;
}

export function routesForAgenda(): Record<string, RouteKind> {
  const r: Record<string, RouteKind> = {};
  for (const d of Q.decisions) {
    const k = routeOf(d.id);
    if (k) r[d.id] = k;
  }
  return r;
}

export function agenda() {
  return buildAgenda(Q.decisions, routesForAgenda(), Q.persona.projects, new Set(Object.keys(S.answered)));
}

/** Decisions not yet answered by the person, including ones Bug Me settled: all can be re-routed. */
export function waitingIds(): string[] {
  return Q.decisions.filter((d) => !S.answered[d.id]).map((d) => d.id);
}

export function firstAgendaId(): string | null {
  const a = agenda();
  for (const s of a.sections) {
    const first = s.decisions[0] ?? s.check_ins[0];
    if (first) return first.id;
  }
  return null;
}
