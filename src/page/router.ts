// Which screen is showing, from the URL hash, so Back and Forward, reload and direct links all work.
// One view at a time: home (the overview), focus (one decision), between (a change of project), and
// the secondary views, and Dispatch (docs/STAGE-8.md). A link to an unknown decision falls back to home.

export type Route =
  | { view: "home" }
  | { view: "focus"; id: string }
  | { view: "between"; project: string }
  | { view: "settled" }
  | { view: "rules" }
  | { view: "record" }
  | { view: "dispatch"; id?: string }
  | { view: "welcome" };

export function parseRoute(hash: string, knownIds: Set<string>): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "d" && parts[1] && knownIds.has(parts[1])) return { view: "focus", id: parts[1] };
  if (parts[0] === "between" && parts[1]) return { view: "between", project: parts[1] };
  if (parts[0] === "settled") return { view: "settled" };
  if (parts[0] === "rules") return { view: "rules" };
  if (parts[0] === "record") return { view: "record" };
  if (parts[0] === "welcome") return { view: "welcome" };
  if (parts[0] === "dispatch") return parts[1] ? { view: "dispatch", id: parts[1] } : { view: "dispatch" };
  return { view: "home" };
}

export function hrefFor(r: Route): string {
  switch (r.view) {
    case "home":
      return "#/";
    case "focus":
      return `#/d/${encodeURIComponent(r.id)}`;
    case "between":
      return `#/between/${encodeURIComponent(r.project)}`;
    case "dispatch":
      return r.id ? `#/dispatch/${encodeURIComponent(r.id)}` : "#/dispatch";
    default:
      return `#/${r.view}`;
  }
}

/** Navigate. The hashchange listener in main.ts renders the new view. */
export function go(r: Route): void {
  const href = hrefFor(r);
  if (location.hash === href) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = href;
}
