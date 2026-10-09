// Guided tours over the real app (catalog: src/shared/tours.ts), drawn with driver.js. The tour only
// points and explains: the visitor clicks the real buttons, a step finishes when they do (or when
// the expected element appears), and the overlay never blocks the page. The app re-renders often,
// so the current step's target is re-found after every render. Escape or the close button ends it.

import { type Driver, type DriveStep, driver } from "driver.js";
import { EXAMPLES } from "../shared/examples";
import { TOURS, type Tour, type TourStep } from "../shared/tours";
import { stopVoiceUnlessFor } from "./card";
import { $, announce, h } from "./dom";
import { go } from "./router";
import { Q, S, fresh, save, setF, setS } from "./state";

/** How long a step waits for its target or its expected element, in ms, before offering a retry. */
const STEP_WAIT_MS = 12_000;
/** How long an optional step (such as pushback) waits before the tour skips it. Heuristic: longer
 *  than the answer check takes on a recorded run, short enough not to feel stuck. */
const OPTIONAL_WAIT_MS = 2_500;

interface Running {
  tour: Tour;
  index: number;
  drv: Driver;
  /** Ends the current step's wait (a click, an element appearing, or Next). */
  finishStep: (() => void) | null;
  stopped: boolean;
  /** Where focus goes when the tour ends. */
  returnFocus: HTMLElement | null;
}

let run: Running | null = null;

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function tourActive(): boolean {
  return Boolean(run && !run.stopped);
}

/** Start a tour, from a fresh morning. Asks first (in the page, not a browser dialog) if there is progress to lose. */
export function startTour(id: string): void {
  const tour = TOURS.find((t) => t.id === id);
  if (!tour) return;
  const hasProgress = S.record.length > 0 || Object.keys(S.punts).length > 0;
  if (!hasProgress) return begin(tour);
  confirmFresh(tour, () => begin(tour));
}

function confirmFresh(tour: Tour, ok: () => void): void {
  const yes = h("button", { type: "button", class: "primary" }, `Start “${tour.title}”`);
  const no = h("button", { type: "button", class: "ghost" }, "Not now");
  const dlg = h(
    "dialog",
    { class: "ts", "aria-labelledby": "tour-confirm-h" },
    h("h2", { id: "tour-confirm-h" }, "Start a fresh morning?"),
    h("p", {}, "Tours start from the beginning of Jordan's morning, so your answers so far will be cleared. You can export your record first from Record."),
    h("div", { class: "row" }, yes, no),
  ) as HTMLDialogElement;
  document.body.append(dlg);
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  yes.addEventListener("click", () => {
    close();
    ok();
  });
  no.addEventListener("click", close);
  dlg.showModal();
}

function begin(tour: Tour): void {
  stopTour();
  setS(fresh(Q));
  setF(null);
  stopVoiceUnlessFor("");
  save();
  const drv = driver({
    animate: !reduceMotion(),
    smoothScroll: !reduceMotion(),
    allowClose: true,
    allowKeyboardControl: true,
    overlayClickBehavior: "none",
    disableActiveInteraction: false,
    overlayOpacity: 0.45,
    stagePadding: 8,
    stageRadius: 12,
    popoverClass: "bm-tour",
    onDestroyStarted: () => stopTour(),
  });
  run = { tour, index: 0, drv, finishStep: null, stopped: false, returnFocus: document.activeElement as HTMLElement | null };
  void play(run);
}

export function stopTour(): void {
  if (!run) return;
  const r = run;
  r.stopped = true;
  r.finishStep?.();
  run = null;
  if (r.drv.isActive()) r.drv.destroy();
  (r.returnFocus?.isConnected ? r.returnFocus : document.querySelector<HTMLElement>("#view h1, #now"))?.focus?.();
}

/** Called after every app render: re-find the current step's target if the render replaced it. */
export function tourAfterRender(): void {
  if (!run || run.stopped) return;
  const step = run.tour.steps[run.index];
  const el = document.querySelector(step.target);
  if (el && run.drv.isActive() && run.drv.getActiveElement() !== el) show(run, step, el);
}

function waitFor(selector: string, r: Running, ms = STEP_WAIT_MS): Promise<Element | null> {
  return new Promise((resolve) => {
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el || r.stopped) {
        obs.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, ms);
  });
}

function exampleText(step: TourStep): string | null {
  if (!step.example) return null;
  if (step.example.text) return step.example.text;
  // A recorded reason is only needed when live calls are off; with a live model, people use their own words.
  if (Q.mode === "live") return null;
  return EXAMPLES.find((e) => e.id === step.example!.decision)?.reason ?? null;
}

function show(r: Running, step: TourStep, el: Element): void {
  const last = r.index === r.tour.steps.length - 1;
  const byNext = step.until === "next";
  const ds: DriveStep = {
    element: el,
    popover: {
      title: step.title,
      description: step.text,
      side: step.side,
      showButtons: byNext ? ["next", "close"] : ["close"],
      nextBtnText: last ? "Done" : "Next",
      progressText: `${r.index + 1} of ${r.tour.steps.length}`,
      showProgress: true,
      onNextClick: () => r.finishStep?.(),
      onCloseClick: () => stopTour(),
      onPopoverRender: (pop) => {
        const text = exampleText(step);
        if (!text) return;
        const label = step.example?.text ? "Use this sentence" : "Use Jordan's words (recorded)";
        const btn = h("button", { type: "button", class: "bm-example" }, label);
        btn.addEventListener("click", () => {
          const ta = document.querySelector<HTMLTextAreaElement>(step.example!.textarea);
          if (!ta) return;
          ta.value = text;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.focus();
        });
        // In the description, not the footer: driver.js hides the footer on steps without a Next button.
        pop.description.append(h("br"), btn);
      },
    },
  };
  r.drv.highlight(ds);
  announce(`Tour step ${r.index + 1} of ${r.tour.steps.length}: ${step.title}. ${step.text}`);
}

/** Resolve when the visitor completes the step: clicks the target selector, the element appears, or presses Next. */
function stepDone(r: Running, step: TourStep): Promise<void> {
  return new Promise((resolve) => {
    let cleanup = () => {};
    r.finishStep = () => {
      cleanup();
      r.finishStep = null;
      resolve();
    };
    if (step.until === "next") return;
    if ("click" in step.until) {
      const sel = step.until.click;
      const onClick = (e: Event) => {
        if ((e.target as Element | null)?.closest?.(sel)) setTimeout(() => r.finishStep?.(), 0); // let the app act first
      };
      document.addEventListener("click", onClick, true);
      cleanup = () => document.removeEventListener("click", onClick, true);
    } else {
      void waitFor(step.until.appear, r).then((el) => el && r.finishStep?.());
    }
  });
}

async function play(r: Running): Promise<void> {
  const steps = r.tour.steps;
  while (r.index < steps.length && !r.stopped) {
    const step = steps[r.index];
    if (step.go && location.hash !== step.go) go(parseHash(step.go));
    const el = await waitFor(step.target, r, step.optional ? OPTIONAL_WAIT_MS : STEP_WAIT_MS);
    if (r.stopped) return;
    if (!el && step.optional) {
      r.index++;
      continue;
    }
    if (!el) {
      if (!(await offerRetry(r, step))) return;
      continue;
    }
    show(r, step, el);
    await stepDone(r, step);
    r.index++;
  }
  if (!r.stopped) finish(r);
}

function parseHash(hash: string): Parameters<typeof go>[0] {
  const p = hash.replace(/^#\/?/, "").split("/");
  if (p[0] === "d" && p[1]) return { view: "focus", id: p[1] };
  if (p[0] === "settled" || p[0] === "rules" || p[0] === "record") return { view: p[0] };
  return { view: "home" };
}

/** A step whose target never appeared: say so plainly, and offer to try again or end the tour. */
function offerRetry(r: Running, step: TourStep): Promise<boolean> {
  return new Promise((resolve) => {
    r.drv.highlight({
      element: "#view",
      popover: {
        title: "This step didn't show up",
        description: `The tour expected “${step.title}” here. If you went a different way, you can try again or end the tour and explore freely.`,
        showButtons: ["next", "close"],
        nextBtnText: "Try again",
        onNextClick: () => resolve(true),
        onCloseClick: () => {
          stopTour();
          resolve(false);
        },
      },
    });
  });
}

function finish(r: Running): void {
  r.drv.highlight({
    element: "#view",
    popover: {
      title: `That's “${r.tour.title}”.`,
      description: "Keep exploring as Jordan, or pick another tour.",
      showButtons: ["next", "close"],
      nextBtnText: "Keep exploring",
      onNextClick: () => stopTour(),
      onCloseClick: () => stopTour(),
    },
  });
}

/** The Tours menu in the bar: a small dialog listing every tour. */
export function openToursMenu(): void {
  const list = h(
    "ul",
    { class: "tour-list" },
    ...TOURS.map((t) =>
      h(
        "li",
        {},
        h(
          "button",
          { type: "button", class: "tour-item", "data-tour": t.id },
          h("img", { src: `/firefly/${t.mood}.svg`, alt: "", width: 32, height: 32 }),
          h("span", {}, h("b", {}, t.title), h("span", { class: "quiet" }, ` · ${t.minutes} min`), h("span", { class: "tour-blurb" }, t.blurb)),
        ),
      ),
    ),
  );
  const close = h("button", { type: "button", class: "ghost" }, "Close");
  const dlg = h("dialog", { class: "ts tours", "aria-labelledby": "tours-h" }, h("h2", { id: "tours-h" }, "Tours"), list, close) as HTMLDialogElement;
  document.body.append(dlg);
  const done = () => {
    dlg.close();
    dlg.remove();
  };
  close.addEventListener("click", done);
  list.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-tour]");
    if (!b) return;
    done();
    startTour(b.dataset.tour!);
  });
  dlg.showModal();
  void $;
}
