// Always-on voice (docs/STAGE-3.md), controlled by a microphone button inside the box speech fills
// (docs/STAGE-6.md). The clay firefly in the top-right corner shows the morning's glow and, while
// listening, is attentive and brightens for a moment whenever it hears speech.
//
// One button, made once, moves into whichever box is the target. Clicking it turns listening on (the
// browser asks for microphone permission once) and it stays on across cards until clicked again.
// The words being heard show under the box.
//
// Where speech goes is decided by whatever is on screen: each render names a target (the card's Why
// box, the "why?" prompt, the reason for setting something aside) or none. With no target, capture
// pauses. Each target gets its own recognition session; a result from an earlier session is dropped,
// so speech can never land in a card that is not in front of the person. Finished phrases are
// appended to the box's current text, so typing is never overwritten; unfinished words show only
// beside the firefly.

import { VOICE_DRAIN_MS, VOICE_MAX_FAILURES, VOICE_RETRY_BASE_MS } from "../shared/constants";
import { h } from "./dom";

/** Where recognized speech is written. `key` identifies the box (decision and field). */
export interface VoiceTarget {
  key: string;
  /** The textarea on screen now (renders replace elements, so it is looked up each time). */
  el: () => HTMLTextAreaElement | null;
  /** Store the new text in the app's state (the flow), so it survives a re-render. */
  write: (text: string) => void;
}

interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}
export interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

/** How long the firefly stays brightened after hearing words, in ms. Heuristic: one breath. */
const HEARD_GLOW_MS = 1500;
/** How long the last heard words stay beside the firefly after speech stops, in ms. Heuristic. */
const HEARD_TEXT_MS = 4000;

/** The six clay moods (docs/brand). Listening shows attentive, or pleased while it hears speech;
 *  off, the firefly shows the morning's glow, which views.ts sets from the person's reasons. */
export type Mood = "resting" | "attentive" | "pleased" | "delighted" | "disappointed" | "sheepish";

let enabled = false;
let target: VoiceTarget | null = null;
let session: { rec: SpeechRec; key: string; gen: number; failed: boolean } | null = null;
/** Speech-service failures in a row; reset by any recognized speech. */
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Words heard but not yet final in the running session, and who is waiting for them to finish. */
let interimPending = false;
let drainWaiters: (() => void)[] = [];

function releaseDrain(): void {
  const w = drainWaiters;
  drainWaiters = [];
  for (const f of w) f();
}

/**
 * Before an answer is sent: if a phrase is still being heard, ask the service to finish it (stop()
 * still delivers the captured words) and wait for it, at most VOICE_DRAIN_MS, so the last words of a
 * reason or condition reach the box before the answer goes out.
 */
export function drainVoice(): Promise<void> {
  if (!session || !interimPending) return Promise.resolve();
  const s = session;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      drainWaiters = drainWaiters.filter((f) => f !== done);
      resolve();
    }, VOICE_DRAIN_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    drainWaiters.push(done);
    s.rec.stop();
  });
}
let generation = 0;
let blocked = "";
let heardTimer: ReturnType<typeof setTimeout> | undefined;
let textTimer: ReturnType<typeof setTimeout> | undefined;
let pleased = false;
let glowMood: Mood = "attentive";
let glowLabel = "";
/** The microphone button and the heard-words line, made once and moved into the target's box. */
let micBtn: HTMLButtonElement | null = null;
let says: HTMLElement | null = null;
let heardEl: HTMLElement | null = null;
let noteEl: HTMLElement | null = null;

function recognizer(): (new () => SpeechRec) | null {
  const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return W.SpeechRecognition ?? W.webkitSpeechRecognition ?? null;
}

/** Draw the firefly once, into #voice (it lives outside the bar so re-renders don't restart it), and
 *  make the microphone button that setVoiceTarget places in the box speech goes to. */
export function initVoice(): void {
  const root = document.getElementById("voice");
  if (!root || root.childElementCount) return;
  root.append(h("span", { class: "voice-glow", role: "img", id: "voice-glow" }, clip()));
  if (recognizer()) {
    micBtn = h(
      "button",
      { type: "button", class: "mic", id: "voice-btn", "aria-pressed": "false", onclick: () => toggle() },
      micIcon(),
    ) as HTMLButtonElement;
    heardEl = h("p", { class: "voice-heard", id: "voice-heard", "aria-live": "polite" });
    noteEl = h("p", { class: "voice-note", id: "voice-note" });
    says = h("div", { class: "voice-says" }, heardEl, noteEl);
  }
  paint();
}

function micIcon(): Element {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>';
  return svg;
}

/** Put the microphone in the target's box (the field around its textarea), or take it away. */
function place(): void {
  if (!micBtn || !says) return;
  const box = target?.el()?.closest<HTMLElement>(".think-field, .basis-row");
  if (!box) {
    micBtn.remove();
    says.remove();
    return;
  }
  if (micBtn.parentElement !== box) box.append(micBtn);
  if (says.previousElementSibling !== box) box.after(says);
}

/** The firefly's clay loop, one element whose source follows the mood, with a still for reduced motion
 *  (the brand README's recipe: Safari's HEVC file first, then VP9). */
function clip(): HTMLElement {
  const v = h("video", { class: "voice-clip moving", autoplay: true, loop: true, muted: true, playsinline: true, width: 64, height: 64, "aria-hidden": "true" }) as HTMLVideoElement;
  v.muted = true; // the attribute alone does not satisfy every browser's autoplay rule
  const still = h("img", { class: "voice-clip still", alt: "", width: 64, height: 64 });
  return h("span", { class: "voice-mood" }, v, still);
}

let shownMood: Mood | null = null;

/** Point the clip at a mood's files, only when the mood changes (so the loop does not restart). */
function showMood(m: Mood): void {
  if (shownMood === m) return;
  shownMood = m;
  const v = document.querySelector<HTMLVideoElement>("#voice video.voice-clip");
  const still = document.querySelector<HTMLImageElement>("#voice img.voice-clip");
  if (still) still.src = `/firefly/clay/${m}.png`;
  if (!v) return;
  v.poster = `/firefly/clay/${m}.png`;
  v.replaceChildren(
    h("source", { src: `/firefly/clay/${m}_safari.mp4`, type: 'video/mp4; codecs="hvc1"' }),
    h("source", { src: `/firefly/clay/${m}.webm`, type: "video/webm" }),
  );
  v.load();
  void v.play?.().catch(() => {});
}

/** The morning's glow, shown while not listening (views.ts calls this on every render). */
export function setGlowMood(m: Mood, label: string): void {
  glowMood = m;
  glowLabel = label;
  paint();
}

function mood(): Mood {
  if (!enabled || blocked) return glowMood;
  return pleased ? "pleased" : "attentive";
}

/** Show the state: which mood, whether listening or paused, and the one-time notice. */
function paint(): void {
  const root = document.getElementById("voice");
  if (!root) return;
  const m = mood();
  root.dataset.mood = m;
  showMood(m);
  const state = !enabled ? "off" : blocked ? "blocked" : session ? "listening" : "paused";
  root.dataset.state = state;
  const glow = document.getElementById("voice-glow");
  glow?.setAttribute("aria-label", `Bug Me's firefly. ${glowLabel}`.trim());
  glow?.setAttribute("title", `Bug Me's firefly. ${glowLabel}`.trim());
  place();
  const btn = micBtn;
  if (btn) btn.dataset.state = state;
  btn?.setAttribute("aria-pressed", String(enabled && !blocked));
  const label = !enabled ? "Talk instead of typing" : blocked ? `Microphone unavailable: ${blocked}` : session ? "Listening. Click to stop." : "Listening paused here. Click to stop.";
  btn?.setAttribute("aria-label", label);
  btn?.setAttribute("title", label);
  const note = noteEl;
  if (note) {
    note.textContent = blocked
      ? `Microphone unavailable (${blocked}).`
      : enabled
        ? session
          ? "Listening. Speech is processed by your browser's speech service."
          : "Listening pauses here; it picks up on the next card."
        : "";
  }
}

function toggle(): void {
  if (enabled) {
    enabled = false;
    stopSession();
  } else {
    enabled = true;
    blocked = "";
    failures = 0;
    sync();
  }
  paint();
}

/** Name where speech goes now, or null for nowhere. Called on every render. */
export function setVoiceTarget(t: VoiceTarget | null): void {
  target = t;
  sync();
  paint();
}

/** Turn voice off entirely (a fresh morning, a tour starting). */
export function voiceOff(): void {
  enabled = false;
  target = null;
  stopSession();
  paint();
}

function stopSession(): void {
  clearTimeout(retryTimer);
  interimPending = false;
  releaseDrain();
  if (!session) return;
  generation++; // results still in flight from this session are dropped
  const s = session;
  session = null;
  s.rec.stop();
}

/** Make the running session match the target: start, keep, switch, or pause. */
function sync(): void {
  if (!enabled || blocked || !target) {
    stopSession();
    return;
  }
  if (session?.key === target.key) return;
  stopSession();
  const Ctor = recognizer();
  if (!Ctor) return;
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  const gen = ++generation;
  const key = target.key;
  rec.onresult = (e) => {
    if (gen !== generation || !target || target.key !== key) return;
    failures = 0;
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const words = r[0].transcript.trim();
      if (!words) continue;
      if (r.isFinal) append(target, words);
      else interim += `${words} `;
    }
    interimPending = Boolean(interim.trim());
    heard(interim.trim() || lastFinal);
    if (!interimPending) releaseDrain();
  };
  rec.onerror = (e) => {
    if (gen !== generation) return;
    // Silence and our own stop end a session normally; the service just needs restarting.
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      blocked = "permission was not given";
      stopSession();
      paint();
      return;
    }
    failures++;
    if (session) session.failed = true;
    if (failures >= VOICE_MAX_FAILURES) {
      blocked = `the speech service isn't responding (${e.error})`;
      stopSession();
      paint();
    }
  };
  rec.onend = () => {
    // The speech service ends sessions on its own after silence; pick up again if nothing changed.
    // After a failure, wait a little longer each time before trying again.
    if (gen !== generation || !session) return;
    interimPending = false;
    releaseDrain();
    const failed = session.failed;
    session = null;
    clearTimeout(retryTimer);
    if (failed) retryTimer = setTimeout(() => (sync(), paint()), VOICE_RETRY_BASE_MS * failures);
    else sync();
    paint();
  };
  session = { rec, key, gen, failed: false };
  try {
    rec.start();
  } catch {
    session = null;
  }
}

let lastFinal = "";

/** Add a finished phrase to the end of the box's current text (never replacing what is typed). */
function append(t: VoiceTarget, words: string): void {
  lastFinal = words;
  const el = t.el();
  const current = el ? el.value : "";
  const next = current.trim() ? `${current.replace(/\s+$/, "")} ${words}` : words;
  t.write(next);
  if (el) {
    el.value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/** Show the words beside the firefly and brighten it for a moment. */
function heard(words: string): void {
  const p = heardEl;
  if (p && words) p.textContent = `“${words}”`;
  pleased = true;
  clearTimeout(heardTimer);
  heardTimer = setTimeout(() => {
    pleased = false;
    paint();
  }, HEARD_GLOW_MS);
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    if (heardEl) heardEl.textContent = "";
  }, HEARD_TEXT_MS);
  paint();
}

/** Test and debugging aid: the key of the box speech currently goes to, or "". */
export function voiceTargetKey(): string {
  return session ? session.key : "";
}

