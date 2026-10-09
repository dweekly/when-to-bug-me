// Decision briefings (src/page/visuals-layout.ts, drawn by src/page/visuals.ts). Vitest runs in Node
// with no DOM, so these tests check the pure half: the screen-reader description of every fixture
// visual, and the layout geometry at both drawing widths (everything inside the viewBox, labels not
// colliding, the accent only on the selected option). What it looks like is checked by eye with
// `npm run preview:visuals` and scripts/visuals-preview.html.

import { describe, expect, it } from "vitest";
import type { Decision, Visual } from "../../src/shared/types";
import {
  ACCENT_CLASSES,
  MONO_EM,
  NARROW,
  SANS_EM,
  WIDE,
  VZ,
  chartPanel,
  clock12,
  clockRange,
  describeVisual,
  layoutTimeline,
  layoutVisual,
  minutes,
  payloadLine,
  repeatDays,
  sparkPath,
  type Scene,
  type SceneNode,
} from "../../src/page/visuals-layout";
import { decisions } from "./helpers";

const withVisual = decisions.filter((d): d is Decision & { visual: Visual } => d.visual !== undefined);
const byId = (id: string) => {
  const d = withVisual.find((x) => x.id === id);
  if (!d) throw new Error(`no fixture decision ${id} with a visual`);
  return d;
};

/** The ink box a text node covers, from the same width estimate the layouts use. */
function textBox(n: SceneNode): { x0: number; x1: number; y0: number; y1: number } {
  const size = Number(n.a["font-size"]);
  const w = (n.spans ?? []).reduce((acc, s) => acc + (s.dx ?? 0) + s.text.length * size * (s.cls?.includes(VZ.mono) ? MONO_EM : SANS_EM), 0);
  const x = Number(n.a.x);
  const anchor = n.a["text-anchor"];
  const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
  const y = Number(n.a.y);
  return { x0, x1: x0 + w, y0: y - size * 0.8, y1: y + size * 0.25 };
}

function classesOf(scene: Scene): string[] {
  return scene.nodes.flatMap((n) => [n.cls ?? "", ...(n.spans ?? []).map((s) => s.cls ?? "")]).flatMap((c) => c.split(/\s+/)).filter(Boolean);
}

describe("fixture visuals", () => {
  it("covers the eight briefings the stage 2 plan names, one per kind at least", () => {
    expect(withVisual.map((d) => d.id).sort()).toEqual(
      ["api-rename", "berlin-sync", "ci-runners", "free-tier", "onsite-flight", "outage-chart", "provider-contract", "webhook-rename"].sort(),
    );
    expect(new Set(withVisual.map((d) => d.visual.kind))).toEqual(new Set(["timeline", "clocks", "chart", "payload", "bars"]));
  });

  it("only refer to option keys the decision has", () => {
    for (const d of withVisual) {
      const v = d.visual;
      const keys =
        v.kind === "timeline" ? v.bars.map((b) => b.option) : v.kind === "bars" ? v.items.map((i) => i.option) : v.kind === "chart" || v.kind === "payload" ? Object.keys(v.variants) : [];
      for (const k of keys) expect(d.options.map((o) => o.key), `${d.id} option ${k}`).toContain(k);
    }
  });
});

describe("describeVisual", () => {
  it("names every option of every fixture visual (clocks have none) and ends in a sentence", () => {
    for (const d of withVisual) {
      const text = describeVisual(d.visual, d);
      expect(text.length, d.id).toBeGreaterThan(40);
      expect(text, d.id).toMatch(/\.$/);
      if (d.visual.kind !== "clocks") for (const o of d.options) expect(text, `${d.id} ${o.key}`).toContain(`Option ${o.key}, ${o.label}`);
    }
  });

  it("timeline: fares, times, and where each flight lands against the onsite start", () => {
    const d = byId("onsite-flight");
    expect(describeVisual(d.visual, d)).toBe(
      "Timeline from 5am to 1pm. Onsite starts at 10am. " +
        "Option A, 6:05am flight: $212, 6:05am to 8:50am, ending 1 hour 10 minutes before onsite starts. " +
        "Option B, 9:40am flight: $392, 9:40am to 12:35pm, ending 2 hours 35 minutes after onsite starts.",
    );
  });

  it("clocks: both zones' times and the repeat", () => {
    const d = byId("berlin-sync");
    expect(describeVisual(d.visual, d)).toBe("The same meeting on 2 clocks: Jordan (Pacific) 7:30am; Berlin 4:30pm. Every Tuesday, 30 minutes.");
  });

  it("chart: the omitted version's range and the annotated spike", () => {
    const d = byId("outage-chart");
    const text = describeVisual(d.visual, d);
    expect(text).toContain("Option A, Leave it out: the spike is left out, so the line ranges 174 to 192.");
    expect(text).toContain('the spike to 2,400 stays, labelled "Sep 30: 3-hour outage"');
  });

  it("payload: the renamed and the kept field, and who reads it", () => {
    for (const id of ["api-rename", "webhook-rename"]) {
      const d = byId(id);
      const v = d.visual as Extract<Visual, { kind: "payload" }>;
      const text = describeVisual(v, d);
      for (const [key, name] of Object.entries(v.variants)) {
        expect(text).toContain(name === v.field ? `${key}, ${d.options.find((o) => o.key === key)!.label}: the field stays ${name}` : `the field is renamed to ${name}`);
      }
      expect(text).toContain(v.reach);
    }
  });

  it("bars: every item's label, value, unit and note", () => {
    for (const id of ["free-tier", "ci-runners", "provider-contract"]) {
      const d = byId(id);
      const v = d.visual as Extract<Visual, { kind: "bars" }>;
      const text = describeVisual(v, d);
      for (const it of v.items) expect(text).toContain(`${it.label} (${it.value.toLocaleString("en-US")} ${v.unit}), ${it.note}`);
    }
  });
});

describe("layouts", () => {
  const cases = withVisual.flatMap((d) => [NARROW, WIDE].flatMap((w) => [null, ...d.options.map((o) => o.key)].map((sel) => ({ d, w, sel }))));

  it.each(cases.map((c) => [c.d.id, c.w, c.sel ?? "none", c] as const))("%s at %i, selected %s: everything inside the viewBox", (_id, _w, _s, { d, w, sel }) => {
    const scene = layoutVisual(d.visual, d, sel, w);
    expect(scene.w).toBe(w);
    expect(scene.h).toBeGreaterThan(40);
    for (const n of scene.nodes) {
      for (const [k, v] of Object.entries(n.a)) if (typeof v === "number") expect(Number.isFinite(v), `${k}`).toBe(true);
      if (n.tag === "text") {
        const b = textBox(n);
        expect(b.x0, `${n.spans?.map((s) => s.text).join("")} left`).toBeGreaterThanOrEqual(-0.5);
        expect(b.x1, `${n.spans?.map((s) => s.text).join("")} right`).toBeLessThanOrEqual(w + 0.5);
        expect(b.y0).toBeGreaterThanOrEqual(-0.5);
        expect(b.y1).toBeLessThanOrEqual(scene.h + 0.5);
      }
      if (n.tag === "rect") {
        expect(Number(n.a.x) + Number(n.a.width)).toBeLessThanOrEqual(w + 0.5);
        expect(Number(n.a.y) + Number(n.a.height)).toBeLessThanOrEqual(scene.h + 0.5);
      }
      if (n.tag === "circle") {
        expect(Number(n.a.cx) - Number(n.a.r)).toBeGreaterThanOrEqual(-0.5);
        expect(Number(n.a.cx) + Number(n.a.r)).toBeLessThanOrEqual(w + 0.5);
        expect(Number(n.a.cy) + Number(n.a.r)).toBeLessThanOrEqual(scene.h + 0.5);
      }
    }
  });

  it.each(cases.map((c) => [c.d.id, c.w, c.sel ?? "none", c] as const))("%s at %i, selected %s: no two labels overlap", (_id, _w, _s, { d, w, sel }) => {
    const texts = layoutVisual(d.visual, d, sel, w).nodes.filter((n) => n.tag === "text");
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++) {
        const a = textBox(texts[i]);
        const b = textBox(texts[j]);
        const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        expect(overlap, `${texts[i].spans?.map((s) => s.text).join("")} / ${texts[j].spans?.map((s) => s.text).join("")}`).toBe(false);
      }
  });

  it.each(cases.map((c) => [c.d.id, c.w, c.sel ?? "none", c] as const))("%s at %i, selected %s: no label sits on an option's bar", (_id, _w, _s, { d, w, sel }) => {
    const scene = layoutVisual(d.visual, d, sel, w);
    const bars = scene.nodes.filter((n) => n.tag === "rect" && n.cls?.includes(VZ.draw));
    for (const t of scene.nodes.filter((n) => n.tag === "text")) {
      const a = textBox(t);
      for (const r of bars) {
        const x0 = Number(r.a.x);
        const y0 = Number(r.a.y);
        const hit = a.x0 < x0 + Number(r.a.width) && x0 < a.x1 && a.y0 < y0 + Number(r.a.height) && y0 < a.y1;
        expect(hit, t.spans?.map((s) => s.text).join("")).toBe(false);
      }
    }
  });

  it("uses the accent only when an option is selected, and then for that option's marks", () => {
    for (const d of withVisual)
      for (const w of [NARROW, WIDE]) {
        expect(classesOf(layoutVisual(d.visual, d, null, w)).filter((c) => ACCENT_CLASSES.includes(c)), `${d.id} unselected`).toEqual([]);
        // An unknown key lights nothing either.
        expect(classesOf(layoutVisual(d.visual, d, "Z", w)).filter((c) => ACCENT_CLASSES.includes(c))).toEqual([]);
        if (d.visual.kind === "clocks") continue; // the clocks show one meeting, not a per-option mark
        for (const o of d.options) {
          const lit = layoutVisual(d.visual, d, o.key, w).nodes.filter((n) => [n.cls ?? "", ...(n.spans ?? []).map((s) => s.cls ?? "")].some((c) => ACCENT_CLASSES.some((a) => c.split(" ").includes(a))));
          expect(lit.length, `${d.id} ${o.key}`).toBeGreaterThanOrEqual(2); // the option's key and its mark
          // The lit key letter is this option's.
          const keySpans = lit.flatMap((n) => n.spans ?? []).filter((s) => s.cls?.includes(VZ.accentText) && s.text.length === 1);
          expect(keySpans.map((s) => s.text), `${d.id} ${o.key}`).toEqual([o.key]);
        }
      }
  });
});

describe("timeline geometry", () => {
  it("puts the 6:05 flight wholly before the 10:00 line and the 9:40 one across it", () => {
    const d = byId("onsite-flight");
    const v = d.visual as Extract<Visual, { kind: "timeline" }>;
    for (const w of [NARROW, WIDE]) {
      const s = layoutTimeline(v, null, w);
      const mark = s.nodes.find((n) => n.tag === "line" && n.cls?.includes("vz-mark"))!;
      const bars = s.nodes.filter((n) => n.tag === "rect");
      expect(bars).toHaveLength(2);
      const [a, b] = bars.map((r) => [Number(r.a.x), Number(r.a.x) + Number(r.a.width)]);
      const mx = Number(mark.a.x1);
      expect(a[1]).toBeLessThan(mx);
      expect(b[0]).toBeLessThan(mx);
      expect(b[1]).toBeGreaterThan(mx);
      // Bar lengths are proportional to the flight times (2:45 and 2:55).
      expect((a[1] - a[0]) / (b[1] - b[0])).toBeCloseTo(165 / 175, 2);
    }
  });
});

describe("chart geometry", () => {
  const d = byId("outage-chart");
  const v = d.visual as Extract<Visual, { kind: "chart" }>;
  const box = { x: 0, y: 0, w: 290, h: 100 };

  it("omit drops the spike and fits the scale to the rest; the line joins across the gap", () => {
    const p = chartPanel(v.series, v.spike, "omit", box);
    expect(p.points[v.spike]).toBeNull();
    expect(p.max).toBe(192);
    expect(p.min).toBe(174);
    const ys = p.points.filter((q): q is [number, number] => q !== null).map((q) => q[1]);
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(100);
    expect(sparkPath(p.points).match(/M/g)).toHaveLength(1);
  });

  it("annotate keeps the spike as the highest point and squashes the rest near the floor", () => {
    const p = chartPanel(v.series, v.spike, "annotate", box);
    expect(p.max).toBe(2400);
    const spikeY = p.points[v.spike]![1];
    const others = p.points.filter((_, i) => i !== v.spike).map((q) => q![1]);
    expect(spikeY).toBeLessThan(Math.min(...others));
    expect(Math.min(...others)).toBeGreaterThan(80); // the normal days sit in the bottom fifth
  });
});

describe("helpers", () => {
  it("formats times the way the decisions word them", () => {
    expect(clock12(minutes("06:05"))).toBe("6:05am");
    expect(clock12(minutes("10:00"))).toBe("10am");
    expect(clock12(minutes("12:35"))).toBe("12:35pm");
    expect(clock12(minutes("16:30"))).toBe("4:30pm");
    expect(clock12(minutes("00:00"))).toBe("12am");
    expect(clockRange(minutes("06:05"), minutes("08:50"))).toBe("6:05–8:50am");
    expect(clockRange(minutes("09:40"), minutes("12:35"))).toBe("9:40am–12:35pm");
    expect(() => minutes("9.40")).toThrow();
  });

  it("finds the meeting's weekday in the repeat line (Monday first)", () => {
    expect(repeatDays("Every Tuesday, 30 minutes")).toEqual([1]);
    expect(repeatDays("Mondays and Thursdays")).toEqual([0, 3]);
    expect(repeatDays("Daily standup")).toEqual([]);
  });

  it("splits the payload's field line around the key and renames it", () => {
    expect(payloadLine('  "user_id": "usr_41aa",', "user_id", "account_id")).toEqual({ indent: 2, before: "", key: '"account_id"', after: ': "usr_41aa",' });
    expect(payloadLine('  "id": "note_8f2c",', "user_id", "account_id")).toBeNull();
    // Only the quoted key matches, so a field name inside another key or a value is left alone.
    expect(payloadLine('  "created_at": "x",', "created", "created_at")).toBeNull();
  });
});
