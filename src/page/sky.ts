// Home's signature: the night's questions as stars. Each decision the fleet raised is one star in its
// project's constellation, sized by how many agents it blocks. A star is lit once it is handled
// (settled for you, or answered), dim while it waits on the person, and hollow when set aside. It is
// decoration with meaning; the same facts are in the agenda list for screen readers.

import { agenda, routeOf } from "./derive";
import { Q, S, byId } from "./state";

const NS = "http://www.w3.org/2000/svg";

/** Sky size in SVG units; it scales to the page width. */
const W = 720;
const H = 170;

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** A stable pseudo-random number in [0, 1) from a string, so each star keeps its place. */
function hash01(s: string, salt: number): number {
  let x = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return ((x >>> 0) % 10000) / 10000;
}

export function renderSky(): SVGElement {
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "sky", "aria-hidden": "true", focusable: "false" });
  const settled = new Set(agenda().settled.filter((id) => !S.reopened.includes(id)));
  const projects = Q.persona.projects;
  projects.forEach((p, pi) => {
    const cx = (W / projects.length) * (pi + 0.5);
    const cy = H * 0.42;
    const mine = Q.decisions.filter((d) => d.project === p.id);
    const points = mine.map((d) => {
      const angle = hash01(d.id, 1) * Math.PI * 2;
      const radius = 18 + hash01(d.id, 2) * (W / projects.length / 2 - 34);
      return { d, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius * 0.55 };
    });
    // Faint constellation lines: each star to its nearest neighbour.
    for (const a of points) {
      let best = null as (typeof points)[number] | null;
      let bd = Infinity;
      for (const b of points) {
        if (a === b) continue;
        const dd = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (dd < bd) {
          bd = dd;
          best = b;
        }
      }
      if (best) svg.append(el("line", { x1: a.x, y1: a.y, x2: best.x, y2: best.y, class: "sky-line" }));
    }
    for (const { d, x, y } of points) {
      const handled = Boolean(S.answered[d.id]) || settled.has(d.id) || routeOf(d.id) === "settle";
      const aside = Boolean(S.punts[d.id]);
      const r = 2.2 + Math.min(d.unblocks, 6) * 0.7;
      const cls = aside ? "star aside" : handled ? "star lit" : "star waiting";
      if (handled && !aside) svg.append(el("circle", { cx: x, cy: y, r: r * 3.2, class: "star-halo" }));
      svg.append(el("circle", { cx: x, cy: y, r, class: cls, "data-id": d.id }));
    }
    const label = el("text", { x: cx, y: H - 10, class: "sky-label", "text-anchor": "middle" });
    label.textContent = p.name;
    svg.append(label);
  });
  void byId;
  return svg;
}
