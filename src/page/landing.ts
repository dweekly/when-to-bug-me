// The explainer at "/": a short scroll-told story that sets the scene, then sends the visitor into a
// guided tour of the real app (/app?tour=<id>). Counts and example headlines come from /api/queue,
// the same routed morning the app shows; if it can't be reached, the story still reads, with
// "counts unavailable" instead of numbers. Motion is decoration: under reduced motion every section
// shows its end state at once.

import { TOURS } from "../shared/tours";
import type { Card, Persona, RouteKind } from "../shared/types";

interface Queue {
  persona: Persona;
  decisions: { id: string; project: string; unblocks: number }[];
  cards: (Card | { id: string; unavailable: string })[];
  mode: "fake" | "live" | "recorded";
}

const NS = "http://www.w3.org/2000/svg";
const ROUTES: RouteKind[] = ["settle", "check_in", "decide"];

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** A stable pseudo-random number in [0, 1) from a string, so a star keeps its place between visits. */
function hash01(s: string, salt: number): number {
  let x = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return ((x >>> 0) % 10000) / 10000;
}

const isCard = (c: Queue["cards"][number]): c is Card => "route" in c;

/** Sorter geometry (SVG units): stars start scattered across the sky and settle into three columns. */
const SKY = { w: 720, h: 100, colW: 240, gridTop: 18, cell: 22, perRow: 6 };

function drawSorter(svg: SVGElement, cards: Card[]): void {
  const counters: Record<RouteKind, number> = { settle: 0, check_in: 0, decide: 0 };
  for (const c of cards) {
    const col = ROUTES.indexOf(c.route);
    const i = counters[c.route]++;
    const x0 = 20 + hash01(c.id, 1) * (SKY.w - 40);
    const y0 = 8 + hash01(c.id, 2) * (SKY.h - 16);
    const gridW = SKY.perRow * SKY.cell;
    const x1 = col * SKY.colW + (SKY.colW - gridW) / 2 + (i % SKY.perRow) * SKY.cell + SKY.cell / 2;
    const y1 = SKY.gridTop + Math.floor(i / SKY.perRow) * SKY.cell;
    const star = svgEl("circle", { cx: 0, cy: 0, r: c.route === "decide" ? 6 : 4.5, class: `star ${c.route}` });
    star.style.setProperty("--from", `translate(${x0}px, ${y0}px)`);
    star.style.setProperty("--to", `translate(${x1}px, ${y1}px)`);
    star.style.setProperty("--delay", `${Math.round(hash01(c.id, 3) * 600)}ms`);
    svg.append(star);
  }
}

function fillBins(cards: Card[], decisions: Queue["decisions"]): void {
  const unblocks = new Map(decisions.map((d) => [d.id, d.unblocks]));
  for (const route of ROUTES) {
    const li = $(`[data-route="${route}"]`)!;
    const mine = cards.filter((c) => c.route === route).sort((a, b) => (unblocks.get(b.id) ?? 0) - (unblocks.get(a.id) ?? 0));
    li.querySelector("[data-n]")!.textContent = String(mine.length);
    const q = li.querySelector("[data-headline]")!;
    if (mine[0]) q.textContent = mine[0].headline;
    else q.remove();
  }
}

function drawLanes(q: Queue): void {
  const lanes = $("[data-lanes]")!;
  for (const p of q.persona.projects) {
    const n = q.decisions.filter((d) => d.project === p.id).length;
    const lane = document.createElement("div");
    lane.className = "lane";
    const name = document.createElement("span");
    name.textContent = p.name;
    const dots = document.createElement("span");
    dots.className = "dots";
    dots.textContent = "•".repeat(n);
    lane.append(name, dots);
    lanes.append(lane);
  }
}

function fillPersona(q: Queue): void {
  const p = q.persona;
  $('[data-persona="intro"]')!.textContent = `${p.first_name} is a ${p.role.toLowerCase()} at ${p.company}, ${p.company_blurb}, running ${p.fleet_size} agents on ${p.projects.length} projects.`;
  $('[data-persona="note"]')!.textContent = `“${p.how_to_work_with_me[0]}”`;
}

function tourCards(): void {
  const ul = $("[data-tours]")!;
  for (const t of TOURS) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `/app?tour=${encodeURIComponent(t.id)}`;
    a.dataset.tour = t.id;
    const img = document.createElement("img");
    Object.assign(img, { src: `/firefly/${t.mood}.svg`, alt: "", width: 44, height: 44 });
    const span = (cls: string, text: string) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
    a.append(img, span("t-title", t.title), span("t-blurb", t.blurb), span("t-min", `${t.minutes} min`));
    li.append(a);
    ul.append(li);
  }
}

/** Reveal each section as it scrolls in (the sorter starts sorting then). */
function revealOnScroll(): void {
  const sections = document.querySelectorAll<HTMLElement>(".reveal");
  if (reduceMotion() || !("IntersectionObserver" in window)) {
    for (const s of sections) s.classList.add("shown");
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add("shown");
          io.unobserve(e.target);
        }
    },
    { threshold: 0.25 },
  );
  for (const s of sections) io.observe(s);
}

async function main(): Promise<void> {
  tourCards();
  revealOnScroll();
  let q: Queue;
  try {
    const r = await fetch("/api/queue");
    if (!r.ok) throw new Error(String(r.status));
    q = (await r.json()) as Queue;
  } catch {
    for (const b of document.querySelectorAll("[data-n]")) b.textContent = "–";
    $("[data-sort-note]")!.textContent = "Counts unavailable right now; the app will show the live morning.";
    return;
  }
  const cards = q.cards.filter(isCard);
  $('[data-count="total"]')!.textContent = String(q.decisions.length);
  fillPersona(q);
  drawLanes(q);
  drawSorter($<SVGElement>("[data-sorter]")!, cards);
  fillBins(cards, q.decisions);
  if (q.mode === "recorded") $("[data-mode-note]")!.textContent = "This copy has no live connection, so it replays Claude answers recorded earlier, and every card says so.";
  if (q.mode === "live") $("[data-mode-note]")!.textContent = "This copy is connected to Claude: what you type in a tour gets a live answer. The opening morning is a recorded run, labeled as such.";
}

void main();
