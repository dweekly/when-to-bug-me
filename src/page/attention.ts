// Measured attention (docs/STAGE-11.md): how long each decision's card was in front of the person while
// the tab was visible, every prompt on it counted (the conversation, "why?", pushback, the guidance
// offer). Each stretch is logged to the record as {kind: "attention", id, seconds} when the card leaves
// the screen, so the export and the weekly review carry measured time beside the route-based estimate.
import { F, S, byId, log, save } from "./state";
import { parseRoute } from "./router";

let wanted: string | null = null;
let open: { id: string; since: number; s: typeof S } | null = null;

/** The decision whose card is being worked right now: on screen, still open, not finished. */
function cardInFront(): string | null {
  const f = F;
  if (!f || S.flows[f.id] !== f || f.phase === "done") return null;
  const r = parseRoute(location.hash, new Set(byId.keys()));
  return r.view === "focus" && r.id === f.id ? f.id : null;
}

function close(): void {
  if (!open) return;
  const o = open;
  open = null;
  if (o.s !== S) return; // the morning was started over: that time belongs to a morning that's gone
  const seconds = Math.round((performance.now() - o.since) / 1000);
  if (seconds < 1) return;
  log("attention", { id: o.id, seconds });
  save();
}

function sync(): void {
  const id = document.visibilityState === "visible" ? wanted : null;
  if (open && open.id === id && open.s === S) return;
  close();
  if (id) open = { id, since: performance.now(), s: S };
}

/** Called after every render: starts, keeps or ends the stretch for the card in front. */
export function attend(): void {
  wanted = cardInFront();
  sync();
}

document.addEventListener("visibilitychange", sync);
window.addEventListener("pagehide", () => {
  wanted = null;
  sync();
});
