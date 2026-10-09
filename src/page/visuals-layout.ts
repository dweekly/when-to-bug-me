// Decision briefings as data: the pure half of the visuals. Each layout function turns a decision's
// `visual` (see the Visual type in src/shared/types.ts) into a small scene of SVG primitives with
// coordinates, and describeVisual() writes the same briefing as one plain-text paragraph for screen
// readers. Nothing here touches the DOM, so the unit tests (which run in Node) can check the geometry;
// src/page/visuals.ts turns a scene into real SVG elements.
//
// Every layout is drawn twice, at two viewBox widths: NARROW for phones and WIDE for desktop cards.
// The SVG is never scaled up past its viewBox width (public/visuals.css caps it), so a 12-unit label
// renders at 11 to 12px on a 320 to 390px phone and the wide layout never inflates on a big screen.
// Colors are never set here: nodes carry class names (VZ below) that public/visuals.css paints from
// its --viz-* custom properties, so the one accent appears only where a node is marked selected.

import type { Decision, Visual } from "../shared/types";

/** ViewBox widths of the two layouts, in SVG units. The page shows WIDE once the figure is at least
 * WIDE_FROM_PX wide (a container query in public/visuals.css that must use the same number). At that
 * threshold the wide layout renders at 520/640 = 0.81 scale, so its 14-unit labels are still 11.4px. */
export const NARROW = 340;
export const WIDE = 640;
export const WIDE_FROM_PX = 520;

/** Average advance widths as a fraction of font size, for keeping labels inside the viewBox and off
 * each other. JetBrains Mono is monospaced at 600 units per 1000-unit em (its OS/2 xAvgCharWidth);
 * 0.56 is a deliberately generous estimate for Atkinson Hyperlegible's mixed-case text. */
export const MONO_EM = 0.6;
export const SANS_EM = 0.56;

/** Class names the stylesheet paints. Kept in one place so tests and CSS agree. */
export const VZ = {
  ink: "vz-ink", // primary text and marks
  ink2: "vz-ink2", // secondary text
  ink3: "vz-ink3", // tertiary text, ticks, quiet structure
  mono: "vz-mono",
  sans: "vz-sans",
  bold: "vz-bold",
  hair: "vz-hair", // hairline stroke
  outline: "vz-outline", // an option drawn in ink outline (not chosen)
  accentFill: "vz-accent-fill", // the chosen option's mark
  accentText: "vz-accent-text",
  accentStroke: "vz-accent-stroke",
  band: "vz-band", // the highlighted payload line
  well: "vz-well", // the dark inset behind code
  halo: "vz-halo", // text that knocks out the lines behind it with the canvas color
  draw: "vz-draw", // grows in from the left (bars), unless reduced motion
  trace: "vz-trace", // traces along its length (lines), unless reduced motion
} as const;

/** All the accent classes, so a test can assert none appear when nothing is selected. */
export const ACCENT_CLASSES: string[] = [VZ.accentFill, VZ.accentText, VZ.accentStroke];

export interface Span {
  text: string;
  cls?: string;
  /** Horizontal gap before this span, in SVG units. */
  dx?: number;
}
export interface SceneNode {
  tag: "line" | "rect" | "circle" | "path" | "text";
  a: Record<string, string | number>;
  cls?: string;
  /** For text: the runs that make up the line. */
  spans?: Span[];
}
export interface Scene {
  w: number;
  h: number;
  nodes: SceneNode[];
}

// --- small helpers ----------------------------------------------------------------------------------

const r1 = (n: number) => Math.round(n * 10) / 10;
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** "06:05" -> 365 minutes after midnight. */
export function minutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`not a 24-hour time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 365 -> "6:05am"; 600 -> "10am"; 720 -> "12pm". */
export function clock12(mins: number, opts: { dropZeroMinutes?: boolean } = {}): string {
  const total = ((mins % 1440) + 1440) % 1440;
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? "am" : "pm";
  if (m === 0 && opts.dropZeroMinutes !== false) return `${h}${ap}`;
  return `${h}:${String(m).padStart(2, "0")}${ap}`;
}

/** "6:05–8:50am" when both ends share am/pm, else "9:40am–12:35pm". */
export function clockRange(from: number, to: number): string {
  const a = clock12(from, { dropZeroMinutes: false });
  const b = clock12(to, { dropZeroMinutes: false });
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -2)}–${b}` : `${a}–${b}`;
}

/** 70 -> "1 hour 10 minutes". */
export function duration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m || !h) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export const fmtNum = (n: number) => n.toLocaleString("en-US");

export function textWidth(spans: Span[], size: number): number {
  return spans.reduce((w, s) => w + (s.dx ?? 0) + s.text.length * size * (s.cls?.includes(VZ.mono) ? MONO_EM : SANS_EM), 0);
}

function text(x: number, y: number, size: number, spans: Span[], anchor: "start" | "middle" | "end" = "start", cls?: string): SceneNode {
  return { tag: "text", a: { x: r1(x), y: r1(y), "font-size": size, "text-anchor": anchor }, cls, spans };
}

function optionLabel(decision: Decision, key: string): string | undefined {
  return decision.options.find((o) => o.key === key)?.label;
}

/** The selected key, or null when it names no option of this decision. */
const isSel = (selected: string | null, key: string) => selected !== null && selected === key;

// --- timeline: the flight against the morning ---------------------------------------------------------

export function layoutTimeline(v: Extract<Visual, { kind: "timeline" }>, selected: string | null, W: number): Scene {
  const wide = W >= WIDE;
  const fs = wide ? 14 : 12;
  const tickFs = wide ? 12 : 11;
  const padX = wide ? 20 : 16;
  const from = minutes(v.from);
  const to = minutes(v.to);
  const x = (m: number) => padX + ((m - from) / (to - from)) * (W - 2 * padX);
  const nodes: SceneNode[] = [];

  const top = fs + 10; // room for the mark labels
  const rowH = wide ? 46 : 42;
  const rows0 = top + 8;
  const axisY = rows0 + v.bars.length * rowH + 2;

  // The morning axis with an hour tick every hour and a label every one or two hours.
  nodes.push({ tag: "line", a: { x1: padX, y1: axisY, x2: W - padX, y2: axisY }, cls: VZ.hair });
  const hours: number[] = [];
  for (let m = Math.ceil(from / 60) * 60; m <= to; m += 60) hours.push(m);
  const labelEvery = (W - 2 * padX) / hours.length >= 48 ? 1 : 2;
  hours.forEach((m, i) => {
    nodes.push({ tag: "line", a: { x1: r1(x(m)), y1: axisY, x2: r1(x(m)), y2: axisY + 4 }, cls: VZ.hair });
    if (i % labelEvery === 0) nodes.push(text(x(m), axisY + tickFs + 7, tickFs, [{ text: clock12(m), cls: VZ.mono }], "middle", VZ.ink3));
  });

  // Marks: a thin vertical line through every row, labelled at the top.
  for (const mk of v.marks) {
    const mx = x(minutes(mk.at));
    nodes.push({ tag: "line", a: { x1: r1(mx), y1: top - 2, x2: r1(mx), y2: axisY }, cls: VZ.ink2 + " vz-mark" });
    const spans: Span[] = [{ text: mk.label, cls: VZ.sans }, { text: clock12(minutes(mk.at)), cls: VZ.mono + " " + VZ.ink3, dx: 6 }];
    const w = textWidth(spans, fs);
    const anchor = mx + w / 2 > W - 2 ? "end" : mx - w / 2 < 2 ? "start" : "middle";
    nodes.push(text(anchor === "end" ? W - 2 : anchor === "start" ? 2 : mx, top - 8, fs, spans, anchor, VZ.ink2));
  }

  // One row per option: a label line, then the flight as a bar on the axis's scale.
  v.bars.forEach((b, i) => {
    const sel = isSel(selected, b.option);
    const y = rows0 + i * rowH;
    const x0 = x(minutes(b.from));
    const x1 = x(minutes(b.to));
    const barY = y + fs + 8;
    nodes.push({
      tag: "rect",
      a: { x: r1(x0), y: r1(barY), width: r1(Math.max(2, x1 - x0)), height: 10, rx: 3 },
      cls: cx(sel ? VZ.accentFill : VZ.outline, VZ.draw),
    });
    const spans: Span[] = [
      { text: b.option, cls: cx(VZ.sans, VZ.bold, sel ? VZ.accentText : VZ.ink) },
      { text: b.label, cls: cx(VZ.mono, VZ.ink), dx: 8 },
      { text: clockRange(minutes(b.from), minutes(b.to)), cls: cx(VZ.mono, VZ.ink3), dx: 10 },
    ];
    const w = textWidth(spans, fs);
    const atStart = x0 + w <= W - 2;
    nodes.push(text(atStart ? x0 : Math.max(w + 2, x1), y + fs, fs, spans, atStart ? "start" : "end", VZ.halo));
  });

  return { w: W, h: Math.ceil(axisY + tickFs + 12), nodes };
}

// --- clocks: one meeting in two time zones -------------------------------------------------------------

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Indexes (Monday = 0) of the weekdays named in a repeat line like "Every Tuesday, 30 minutes". */
export function repeatDays(repeat: string): number[] {
  const lower = repeat.toLowerCase();
  return DAYS.map((d, i) => (lower.includes(d.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
}

/** "30 minutes" in a repeat line, as a number, or null. */
export function repeatMinutes(repeat: string): number | null {
  const m = /(\d+)\s*(?:minutes|min)\b/i.exec(repeat);
  return m ? Number(m[1]) : null;
}

/** A point on a clock face: `turn` is a fraction of a full turn clockwise from 12 o'clock. */
function onFace(cx0: number, cy0: number, r: number, turn: number): [number, number] {
  const a = turn * 2 * Math.PI;
  return [r1(cx0 + r * Math.sin(a)), r1(cy0 - r * Math.cos(a))];
}

export function layoutClocks(v: Extract<Visual, { kind: "clocks" }>, W: number): Scene {
  const wide = W >= WIDE;
  const nodes: SceneNode[] = [];
  const n = Math.max(1, v.zones.length);
  const R = wide ? 62 : 50;
  const gap = wide ? 120 : 40;
  const span = n * 2 * R + (n - 1) * gap;
  const cy0 = R + 6;
  const length = repeatMinutes(v.repeat);

  v.zones.forEach((z, i) => {
    const c = (W - span) / 2 + R + i * (2 * R + gap);
    const t = minutes(z.time);
    nodes.push({ tag: "circle", a: { cx: r1(c), cy: cy0, r: R }, cls: VZ.hair });
    for (let k = 0; k < 12; k++) {
      const major = k % 3 === 0;
      const [x1, y1] = onFace(c, cy0, R - (major ? 9 : 5), k / 12);
      const [x2, y2] = onFace(c, cy0, R - 2, k / 12);
      nodes.push({ tag: "line", a: { x1, y1, x2, y2 }, cls: major ? VZ.ink2 + " vz-tick" : VZ.ink3 + " vz-tick" });
    }
    // The meeting's length as an arc just inside the rim, from the start time onward.
    if (length) {
      const rr = R - 14;
      const a0 = (t % 60) / 60;
      const a1 = a0 + Math.min(length, 59) / 60;
      const [sx, sy] = onFace(c, cy0, rr, a0);
      const [ex, ey] = onFace(c, cy0, rr, a1);
      nodes.push({ tag: "path", a: { d: `M${sx} ${sy}A${rr} ${rr} 0 ${a1 - a0 > 0.5 ? 1 : 0} 1 ${ex} ${ey}` }, cls: "vz-arc" });
    }
    const [hx, hy] = onFace(c, cy0, R * 0.48, ((t / 60) % 12) / 12);
    const [mx, my] = onFace(c, cy0, R * 0.74, (t % 60) / 60);
    nodes.push({ tag: "line", a: { x1: r1(c), y1: cy0, x2: hx, y2: hy }, cls: "vz-hand vz-hand-hour" });
    nodes.push({ tag: "line", a: { x1: r1(c), y1: cy0, x2: mx, y2: my }, cls: "vz-hand vz-hand-min" });
    nodes.push({ tag: "circle", a: { cx: r1(c), cy: cy0, r: 3 }, cls: "vz-pin" });
    const timeFs = wide ? 22 : 18;
    nodes.push(text(c, cy0 + R + timeFs + (wide ? 14 : 10), timeFs, [{ text: clock12(t, { dropZeroMinutes: false }), cls: VZ.mono }], "middle", VZ.ink));
    nodes.push(text(c, cy0 + R + timeFs + (wide ? 36 : 30), wide ? 14 : 12, [{ text: z.label, cls: VZ.sans }], "middle", VZ.ink2));
  });

  // The repeat line and a week of dots with the meeting's days filled.
  const days = repeatDays(v.repeat);
  const fs = wide ? 14 : 12;
  const dotGap = wide ? 20 : 18;
  const dotsW = 6 * dotGap;
  let y = cy0 + R + (wide ? 22 : 18) + (wide ? 74 : 60);
  nodes.push(text(W / 2, y, fs, [{ text: v.repeat, cls: VZ.sans }], "middle", VZ.ink2));
  y += wide ? 24 : 22;
  const dotsX = (W - dotsW) / 2;
  "MTWTFSS".split("").forEach((letter, i) => {
    const dx = dotsX + i * dotGap;
    const on = days.includes(i);
    nodes.push({ tag: "circle", a: { cx: r1(dx), cy: r1(y), r: 4 }, cls: on ? "vz-dot-on" : "vz-dot" });
    nodes.push(text(dx, y + 17, 10.5, [{ text: letter, cls: VZ.sans }], "middle", on ? VZ.ink : VZ.ink3));
  });
  return { w: W, h: Math.ceil(y + 24), nodes };
}

// --- chart: the same series drawn under each option -----------------------------------------------------

export interface ChartPanel {
  option: string;
  mode: "omit" | "annotate";
  /** The y-range drawn, after dropping the spike under "omit". */
  min: number;
  max: number;
  /** Plot points, in order; null where the spike was removed (the line joins its neighbours, as the
   * deck's chart would once the point is deleted). */
  points: ([number, number] | null)[];
}

/** Geometry for one sparkline panel inside the box (x, y, w, h). Pure, for the tests. */
export function chartPanel(series: number[], spike: number, mode: "omit" | "annotate", box: { x: number; y: number; w: number; h: number }, option = ""): ChartPanel {
  const kept = series.filter((_, i) => mode === "annotate" || i !== spike);
  const lo = Math.min(...kept);
  const hi = Math.max(...kept);
  const pad = (hi - lo) * 0.12 || 1;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const step = series.length > 1 ? box.w / (series.length - 1) : 0;
  const points = series.map((v, i): [number, number] | null =>
    mode === "omit" && i === spike ? null : [r1(box.x + i * step), r1(box.y + box.h - ((v - yMin) / (yMax - yMin)) * box.h)],
  );
  return { option, mode, min: lo, max: hi, points };
}

export function sparkPath(points: ([number, number] | null)[]): string {
  return points
    .filter((p): p is [number, number] => p !== null)
    .map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`)
    .join("");
}

export function layoutChart(v: Extract<Visual, { kind: "chart" }>, decision: Decision, selected: string | null, W: number): Scene {
  const wide = W >= WIDE;
  const keys = Object.keys(v.variants);
  const n = Math.max(1, keys.length);
  const gap = wide ? 20 : 10;
  const pw = (W - (n - 1) * gap) / n;
  const inset = wide ? 14 : 10;
  const capFs = wide ? 14 : 12;
  const smallFs = wide ? 12 : 10.5;
  const plotH = wide ? 104 : 72;
  const plotTop = inset + capFs + (wide ? 16 : 12);
  const ph = plotTop + plotH + smallFs + (wide ? 18 : 14);
  const nodes: SceneNode[] = [];

  keys.forEach((key, i) => {
    const sel = isSel(selected, key);
    const x0 = i * (pw + gap);
    nodes.push({ tag: "rect", a: { x: r1(x0 + 0.75), y: 0.75, width: r1(pw - 1.5), height: r1(ph - 1.5), rx: 8 }, cls: sel ? VZ.accentStroke + " vz-panel" : VZ.hair + " vz-panel" });
    nodes.push(
      text(x0 + inset, inset + capFs, capFs, [
        { text: key, cls: cx(VZ.sans, VZ.bold, sel ? VZ.accentText : VZ.ink) },
        { text: optionLabel(decision, key) ?? "", cls: cx(VZ.sans, VZ.ink), dx: 6 },
      ]),
    );
    const box = { x: x0 + inset, y: plotTop, w: pw - 2 * inset, h: plotH };
    const mode = v.variants[key];
    const panel = chartPanel(v.series, v.spike, mode, box, key);
    nodes.push({ tag: "line", a: { x1: r1(box.x), y1: r1(box.y + box.h), x2: r1(box.x + box.w), y2: r1(box.y + box.h) }, cls: VZ.hair });
    nodes.push({ tag: "path", a: { d: sparkPath(panel.points), pathLength: 1 }, cls: "vz-spark " + VZ.trace });
    if (mode === "annotate") {
      const p = panel.points[v.spike];
      if (p) {
        nodes.push({ tag: "circle", a: { cx: p[0], cy: p[1], r: 2.75 }, cls: "vz-pin" });
        const right = p[0] > box.x + box.w / 2;
        nodes.push(text(right ? p[0] - 7 : p[0] + 7, p[1] + smallFs * 0.35 + 2, smallFs, [{ text: v.spike_label, cls: VZ.sans }], right ? "end" : "start", VZ.ink2));
      }
    }
    // The y-range drawn, so the two scales can be compared.
    nodes.push(text(box.x, box.y + box.h + smallFs + 8, smallFs, [{ text: `${fmtNum(panel.min)}–${fmtNum(panel.max)}`, cls: VZ.mono }], "start", VZ.ink3));
  });
  return { w: W, h: Math.ceil(ph), nodes };
}

// --- payload: the real response with the field under each option -----------------------------------------

/** The field's line split around the key, with the key replaced by an option's name for it. */
export function payloadLine(line: string, field: string, name: string): { indent: number; before: string; key: string; after: string } | null {
  const quoted = `"${field}"`;
  const at = line.indexOf(quoted);
  if (at < 0) return null;
  const indent = line.length - line.trimStart().length;
  return { indent, before: line.slice(indent, at), key: `"${name}"`, after: line.slice(at + quoted.length) };
}

export function layoutPayload(v: Extract<Visual, { kind: "payload" }>, decision: Decision, selected: string | null, W: number): Scene {
  const wide = W >= WIDE;
  const keys = Object.keys(v.variants);
  const cols = wide ? keys.length : 1;
  const gap = wide ? 20 : 12;
  const cw = (W - (cols - 1) * gap) / cols;
  const pad = wide ? 14 : 12;
  const capFs = wide ? 14 : 12;
  // Fit the longest line under any option's name inside the column.
  const longest = Math.max(
    ...keys.flatMap((k) => v.lines.map((l) => (payloadLine(l, v.field, v.variants[k]) ? l.replace(`"${v.field}"`, `"${v.variants[k]}"`) : l).length)),
  );
  const fs = Math.min(wide ? 13 : 12, r1((cw - 2 * pad) / (longest * MONO_EM)));
  const lh = r1(fs * 1.65);
  const blockH = pad * 2 + v.lines.length * lh - (lh - fs) + 4;
  const colH = capFs + 10 + blockH;
  const nodes: SceneNode[] = [];

  keys.forEach((key, i) => {
    const sel = isSel(selected, key);
    const x0 = wide ? i * (cw + gap) : 0;
    const y0 = wide ? 0 : i * (colH + 16);
    nodes.push(
      text(x0 + 2, y0 + capFs, capFs, [
        { text: key, cls: cx(VZ.sans, VZ.bold, sel ? VZ.accentText : VZ.ink) },
        { text: optionLabel(decision, key) ?? "", cls: cx(VZ.sans, VZ.ink), dx: 6 },
      ]),
    );
    const by = y0 + capFs + 10;
    nodes.push({ tag: "rect", a: { x: r1(x0 + 0.75), y: r1(by + 0.75), width: r1(cw - 1.5), height: r1(blockH - 1.5), rx: 8 }, cls: cx(VZ.well, sel ? VZ.accentStroke : VZ.hair) });
    v.lines.forEach((line, j) => {
      const base = by + pad + 2 + j * lh + fs * 0.8;
      const split = payloadLine(line, v.field, v.variants[key]);
      if (!split) {
        const indent = line.length - line.trimStart().length;
        nodes.push(text(x0 + pad + indent * fs * MONO_EM, base, fs, [{ text: line.trim(), cls: VZ.mono }], "start", VZ.ink3));
        return;
      }
      nodes.push({ tag: "rect", a: { x: r1(x0 + 4), y: r1(base - fs * 0.8 - (lh - fs) / 2), width: r1(cw - 8), height: lh, rx: 4 }, cls: VZ.band });
      nodes.push(
        text(x0 + pad + split.indent * fs * MONO_EM, base, fs, [
          { text: split.before, cls: cx(VZ.mono, VZ.ink3) },
          { text: split.key, cls: cx(VZ.mono, VZ.bold, sel ? VZ.accentText : VZ.ink) },
          { text: split.after, cls: cx(VZ.mono, VZ.ink2) },
        ]),
      );
    });
  });
  const h = wide ? colH : keys.length * colH + (keys.length - 1) * 16;
  return { w: W, h: Math.ceil(h + 2), nodes };
}

// --- bars: one cost or limit per option ------------------------------------------------------------------

export function layoutBars(v: Extract<Visual, { kind: "bars" }>, selected: string | null, W: number): Scene {
  const wide = W >= WIDE;
  const fs = wide ? 14 : 12;
  const noteFs = wide ? 13 : 11.5;
  const max = Math.max(...v.items.map((it) => it.value), 1);
  const span = W - 4;
  const rowH = wide ? 50 : 68;
  const nodes: SceneNode[] = [];
  let bottom = 0; // the lowest point drawn so far
  v.items.forEach((it, i) => {
    const sel = isSel(selected, it.option);
    const y = i * rowH;
    const head: Span[] = [
      { text: it.option, cls: cx(VZ.sans, VZ.bold, sel ? VZ.accentText : VZ.ink) },
      { text: it.label, cls: cx(VZ.mono, VZ.ink), dx: 8 },
    ];
    const note: Span = { text: it.note, cls: cx(VZ.sans, VZ.ink2) };
    const sameLine = wide && textWidth(head, fs) + 16 + textWidth([note], noteFs) <= W - 4;
    nodes.push(text(2, y + fs, fs, sameLine ? [...head, { ...note, dx: 14 }] : head));
    const barY = y + fs + 8;
    nodes.push({ tag: "rect", a: { x: 2, y: r1(barY), width: r1(Math.max(3, (it.value / max) * span)), height: 12, rx: 3 }, cls: cx(sel ? VZ.accentFill : VZ.outline, VZ.draw) });
    if (!sameLine) nodes.push(text(2, barY + 12 + noteFs + 6, noteFs, [note]));
    bottom = sameLine ? barY + 12 : barY + 12 + noteFs + 9;
  });
  return { w: W, h: Math.ceil(bottom + 4), nodes };
}

// --- dispatch and plain-text description ------------------------------------------------------------------

export function layoutVisual(v: Visual, decision: Decision, selected: string | null, W: number): Scene {
  switch (v.kind) {
    case "timeline":
      return layoutTimeline(v, selected, W);
    case "clocks":
      return layoutClocks(v, W);
    case "chart":
      return layoutChart(v, decision, selected, W);
    case "payload":
      return layoutPayload(v, decision, selected, W);
    case "bars":
      return layoutBars(v, selected, W);
  }
}

/** The one-line caption under the drawing, or "" for none. */
export function captionOf(v: Visual): string {
  switch (v.kind) {
    case "chart":
    case "bars":
      return v.unit;
    case "payload":
      return v.reach;
    default:
      return "";
  }
}

const named = (decision: Decision, key: string) => {
  const label = optionLabel(decision, key);
  return label ? `Option ${key}, ${label}` : `Option ${key}`;
};
const sentence = (s: string) => s.replace(/[\s.]+$/, "") + ".";

/** The visual as plain text, for screen readers: everything the drawing says, in reading order. */
export function describeVisual(v: Visual, decision: Decision): string {
  switch (v.kind) {
    case "timeline": {
      const out = [`Timeline from ${clock12(minutes(v.from))} to ${clock12(minutes(v.to))}.`];
      for (const mk of v.marks) out.push(`${sentence(`${mk.label} at ${clock12(minutes(mk.at))}`)}`);
      for (const b of v.bars) {
        const s = minutes(b.from);
        const e = minutes(b.to);
        const rel = v.marks.map((mk) => {
          const at = minutes(mk.at);
          const lower = mk.label.charAt(0).toLowerCase() + mk.label.slice(1);
          return e <= at ? `${duration(at - e)} before ${lower}` : `${duration(e - at)} after ${lower}`;
        });
        out.push(sentence(`${named(decision, b.option)}: ${b.label}, ${clock12(s, { dropZeroMinutes: false })} to ${clock12(e, { dropZeroMinutes: false })}${rel.length ? `, ending ${rel.join(" and ")}` : ""}`));
      }
      return out.join(" ");
    }
    case "clocks": {
      const zones = v.zones.map((z) => `${z.label} ${clock12(minutes(z.time), { dropZeroMinutes: false })}`).join("; ");
      return `The same meeting on ${v.zones.length} clocks: ${zones}. ${sentence(v.repeat)}`;
    }
    case "chart": {
      const out = [`The ${v.unit} chart drawn ${Object.keys(v.variants).length} ways over ${v.series.length} points.`];
      const spikeValue = v.series[v.spike];
      for (const [key, mode] of Object.entries(v.variants)) {
        const p = chartPanel(v.series, v.spike, mode, { x: 0, y: 0, w: 1, h: 1 });
        if (mode === "omit") out.push(sentence(`${named(decision, key)}: the spike is left out, so the line ranges ${fmtNum(p.min)} to ${fmtNum(p.max)}`));
        else {
          const rest = chartPanel(v.series, v.spike, "omit", { x: 0, y: 0, w: 1, h: 1 });
          out.push(sentence(`${named(decision, key)}: the spike to ${fmtNum(spikeValue)} stays, labelled "${v.spike_label}", and the other points, ${fmtNum(rest.min)} to ${fmtNum(rest.max)}, sit flat along the bottom`));
        }
      }
      return out.join(" ");
    }
    case "payload": {
      const out = [`The response payload, ${v.lines.length} lines, with the ${v.field} field under each option.`];
      for (const [key, name] of Object.entries(v.variants)) {
        out.push(sentence(`${named(decision, key)}: ${name === v.field ? `the field stays ${name}` : `the field is renamed to ${name}`}`));
      }
      out.push(sentence(`Who reads it: ${v.reach}`));
      return out.join(" ");
    }
    case "bars": {
      const out = [`Bars comparing ${v.unit}, one per option.`];
      for (const it of v.items) out.push(sentence(`${named(decision, it.option)}: ${it.label} (${fmtNum(it.value)} ${v.unit}), ${it.note}`));
      return out.join(" ");
    }
  }
}
