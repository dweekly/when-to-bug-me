// Decision briefings: draws a decision's `visual` as an inline SVG figure so the trade-off reads at a
// glance (docs/STAGE-2.md, "Design principles"). The geometry and the plain-text description live in
// ./visuals-layout.ts, which has no DOM and is unit-tested; this file only turns a layout's scene into
// SVG elements. Fixture text always goes in through textContent, never as markup.
//
// The figure holds two drawings of the same visual, a narrow one for phones and a wide one for desktop
// cards; public/visuals.css shows exactly one, by the figure's own width (a container query), so the
// hidden one is also out of the accessibility tree. Both point at the same visually hidden description.

import type { Decision, Visual } from "../shared/types";
import { NARROW, WIDE, captionOf, describeVisual, layoutVisual, type Scene } from "./visuals-layout";

export { describeVisual } from "./visuals-layout";

const SVG_NS = "http://www.w3.org/2000/svg";
/** How far a drawing may grow past its viewBox width: lets the 640-unit wide layout fill a 720px card
 * (14-unit labels then render at 15.75px) without growing without bound on a wider one. */
const MAX_UPSCALE = 1.125;
let seq = 0;

function drawScene(scene: Scene, size: "narrow" | "wide", descId: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${scene.w} ${scene.h}`);
  svg.setAttribute("class", `viz-svg viz-svg--${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-labelledby", descId);
  svg.setAttribute("focusable", "false");
  // Drawn at most MAX_UPSCALE times its coordinate width, so labels stay near their designed size.
  svg.style.maxWidth = `${Math.round(scene.w * MAX_UPSCALE)}px`;
  for (const n of scene.nodes) {
    const el = document.createElementNS(SVG_NS, n.tag);
    for (const [k, v] of Object.entries(n.a)) el.setAttribute(k, String(v));
    if (n.cls) el.setAttribute("class", n.cls);
    if (n.tag === "text" && n.spans) {
      for (const s of n.spans) {
        const t = document.createElementNS(SVG_NS, "tspan");
        if (s.cls) t.setAttribute("class", s.cls);
        if (s.dx) t.setAttribute("dx", String(s.dx));
        t.textContent = s.text;
        el.append(t);
      }
    }
    svg.append(el);
  }
  return svg;
}

/**
 * A `<figure class="viz viz-<kind>">` for one decision's visual. `selected` is the option key the
 * person has picked (drawn in the accent), or null to draw every option in plain ink.
 */
export function renderVisual(visual: Visual, decision: Decision, selected: string | null): HTMLElement {
  const fig = document.createElement("figure");
  fig.className = `viz viz-${visual.kind}`;
  if (selected !== null) fig.dataset.selected = selected;
  const descId = `viz-${decision.id}-${++seq}`;

  const desc = document.createElement("p");
  desc.className = "viz-sr";
  desc.id = descId;
  desc.textContent = describeVisual(visual, decision);

  fig.append(
    desc,
    drawScene(layoutVisual(visual, decision, selected, NARROW), "narrow", descId),
    drawScene(layoutVisual(visual, decision, selected, WIDE), "wide", descId),
  );

  const caption = captionOf(visual);
  if (caption) {
    const cap = document.createElement("figcaption");
    cap.className = "viz-caption";
    cap.setAttribute("aria-hidden", "true"); // already part of the description
    if (visual.kind === "payload") cap.append(reachIcon());
    const span = document.createElement("span");
    span.textContent = caption;
    cap.append(span);
    fig.append(cap);
  }
  return fig;
}

/** A small fan-out glyph: one source feeding three readers. */
function reachIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "viz-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const parts: [string, Record<string, string>][] = [
    ["circle", { cx: "3", cy: "8", r: "2" }],
    ["path", { d: "M5 8h3M8 3.5v9M8 3.5h3M8 8h3M8 12.5h3" }],
    ["circle", { cx: "13", cy: "3.5", r: "1.5" }],
    ["circle", { cx: "13", cy: "8", r: "1.5" }],
    ["circle", { cx: "13", cy: "12.5", r: "1.5" }],
  ];
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}
