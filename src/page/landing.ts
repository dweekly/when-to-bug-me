// The explainer at "/": a short scroll-told story that sets the scene, then sends the visitor into a
// guided tour of the real app (/app?tour=<id>). Counts and example headlines come from /api/queue,
// the same routed morning the app shows; if it can't be reached, the story still reads, with
// "counts unavailable" instead of numbers. Motion is decoration: under reduced motion every section
// shows its end state at once.

import { TOURS } from "../shared/tours";
import { buildAgenda } from "../shared/agenda";
import type { Card, Decision, Persona, RouteKind } from "../shared/types";

interface Queue {
  persona: Persona;
  decisions: { id: string; project: string; unblocks: number }[];
  cards: (Card | { id: string; unavailable: string })[];
  mode: "fake" | "live" | "recorded";
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const isCard = (c: Queue["cards"][number]): c is Card => "route" in c;

/** The piles, exactly as Home builds them (src/shared/agenda.ts): the first is the recommendation. */
function drawPiles(q: Queue, cards: Card[]): void {
  const root = $("[data-piles]")!;
  const routes = Object.fromEntries(cards.map((c) => [c.id, c.route])) as Record<string, RouteKind>;
  const headline = new Map(cards.map((c) => [c.id, c.headline]));
  const a = buildAgenda(q.decisions as unknown as Decision[], routes, q.persona.projects);
  let n = 0;
  a.sections.forEach((s, i) => {
    const items = [...s.decisions, ...s.check_ins];
    const pile = document.createElement("div");
    pile.className = i === 0 ? "pile rec" : "pile";
    pile.style.setProperty("--i", String(i));
    const head = document.createElement("p");
    head.className = "pile-head";
    head.textContent = i === 0 ? `Suggested first: ${s.project.name}` : s.project.name;
    const meta = document.createElement("p");
    meta.className = "pile-meta";
    meta.textContent = `${items.length} question${items.length === 1 ? "" : "s"} · about ${s.minutes} min`;
    const ol = document.createElement("ol");
    ol.start = n + 1;
    for (const it of items.slice(0, i === 0 ? 3 : 2)) {
      const li = document.createElement("li");
      li.textContent = headline.get(it.id) || it.id;
      ol.append(li);
    }
    n += items.length;
    pile.append(head, meta);
    if (i === 0) {
      const why = document.createElement("p");
      why.className = "pile-why";
      why.textContent = s.section_reason;
      pile.append(why);
    }
    pile.append(ol);
    root.append(pile);
  });
  const settled = a.settled.length;
  $("[data-settled]")!.textContent = `○ ${settled} more were settled for Jordan without asking: each reversible, cheap, and cleared by one of Jordan's written rules.`;
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
    // The clay head icon for the tour's mood (64 px source, drawn at 44 CSS px).
    Object.assign(img, { src: `/firefly/clay/${t.mood}_icon.png`, alt: "", width: 44, height: 44 });
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
    $("[data-settled]")!.textContent = "Counts unavailable right now; the app shows the morning.";
    return;
  }
  const cards = q.cards.filter(isCard);
  $('[data-count="total"]')!.textContent = String(q.decisions.length);
  fillPersona(q);
  drawLanes(q);
  drawPiles(q, cards);
  if (q.mode === "recorded") $("[data-mode-note]")!.textContent = "This copy has no live connection, so it replays Claude answers recorded earlier, and every card says so.";
  if (q.mode === "live") $("[data-mode-note]")!.textContent = "This copy is connected to Claude: what you type in a tour gets a live answer. The opening morning is a recorded run, labeled as such.";
}

void main();
