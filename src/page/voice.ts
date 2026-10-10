// Always-on voice, shown by the clay firefly in the top-right corner (docs/STAGE-3.md).
//
// The firefly is the one voice control. Off, it rests; clicking it turns listening on (the browser
// asks for microphone permission once) and it stays on across cards until clicked again. While on it
// is attentive, brightens for a moment whenever it hears speech, and shows the words beside it.
//
// Where speech goes is decided by whatever is on screen: each render names a target (the card's Why
// box, the "why?" prompt, the reason for setting something aside) or none. With no target, capture
// pauses. Each target gets its own recognition session; a result from an earlier session is dropped,
// so speech can never land in a card that is not in front of the person. Finished phrases are
// appended to the box's current text, so typing is never overwritten; unfinished words show only
// beside the firefly.

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

type Mood = "resting" | "attentive" | "pleased";

let enabled = false;
let target: VoiceTarget | null = null;
let session: { rec: SpeechRec; key: string; gen: number } | null = null;
let generation = 0;
let blocked = "";
let heardTimer: ReturnType<typeof setTimeout> | undefined;
let textTimer: ReturnType<typeof setTimeout> | undefined;
let pleased = false;

function recognizer(): (new () => SpeechRec) | null {
  const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return W.SpeechRecognition ?? W.webkitSpeechRecognition ?? null;
}

/** Draw the firefly control once, into #voice (it lives outside the bar so re-renders don't restart it). */
export function initVoice(): void {
  const root = document.getElementById("voice");
  if (!root || root.childElementCount) return;
  if (!recognizer()) {
    root.hidden = true;
    return;
  }
  const btn = h(
    "button",
    { type: "button", class: "voice-btn", id: "voice-btn", "aria-pressed": "false", "aria-label": "Listen: say why at any time", onclick: () => toggle() },
    ...(["resting", "attentive", "pleased"] as Mood[]).map((m) => clip(m)),
  );
  const heard = h("p", { class: "voice-heard", id: "voice-heard", "aria-live": "polite" });
  const note = h("p", { class: "voice-note", id: "voice-note" });
  root.append(btn, heard, note);
  paint();
}

/** One mood's clay loop, with its still for reduced motion (the README's recipe: Safari's file first). */
function clip(m: Mood): HTMLElement {
  const v = h(
    "video",
    { class: `voice-clip moving`, "data-mood": m, autoplay: true, loop: true, muted: true, playsinline: true, poster: `/firefly/clay/${m}.png`, width: 64, height: 64, "aria-hidden": "true" },
    h("source", { src: `/firefly/clay/${m}_safari.mp4`, type: 'video/mp4; codecs="hvc1"' }),
    h("source", { src: `/firefly/clay/${m}.webm`, type: "video/webm" }),
  ) as HTMLVideoElement;
  v.muted = true; // the attribute alone does not satisfy every browser's autoplay rule
  const still = h("img", { class: "voice-clip still", "data-mood": m, src: `/firefly/clay/${m}.png`, alt: "", width: 64, height: 64 });
  return h("span", { class: "voice-mood", "data-mood": m }, v, still);
}

function mood(): Mood {
  if (!enabled || blocked) return "resting";
  return pleased ? "pleased" : "attentive";
}

/** Show the state: which mood, whether listening or paused, and the one-time notice. */
function paint(): void {
  const root = document.getElementById("voice");
  if (!root || root.hidden) return;
  const m = mood();
  root.dataset.mood = m;
  root.dataset.state = !enabled ? "off" : blocked ? "blocked" : session ? "listening" : "paused";
  const btn = document.getElementById("voice-btn");
  btn?.setAttribute("aria-pressed", String(enabled && !blocked));
  btn?.setAttribute(
    "aria-label",
    !enabled ? "Listen: say why at any time" : blocked ? `Microphone unavailable: ${blocked}` : session ? "Listening. Click to stop." : "Listening paused here. Click to stop.",
  );
  const note = document.getElementById("voice-note");
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
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const words = r[0].transcript.trim();
      if (!words) continue;
      if (r.isFinal) append(target, words);
      else interim += `${words} `;
    }
    heard(interim.trim() || lastFinal);
  };
  rec.onerror = (e) => {
    if (gen !== generation) return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      blocked = "permission was not given";
      stopSession();
      paint();
    }
  };
  rec.onend = () => {
    // The speech service ends sessions on its own after silence; pick up again if nothing changed.
    if (gen !== generation || !session) return;
    session = null;
    sync();
    paint();
  };
  session = { rec, key, gen };
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
  const p = document.getElementById("voice-heard");
  if (p && words) p.textContent = `“${words}”`;
  pleased = true;
  clearTimeout(heardTimer);
  heardTimer = setTimeout(() => {
    pleased = false;
    paint();
  }, HEARD_GLOW_MS);
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    const q = document.getElementById("voice-heard");
    if (q) q.textContent = "";
  }, HEARD_TEXT_MS);
  paint();
}

/** Test and debugging aid: the key of the box speech currently goes to, or "". */
export function voiceTargetKey(): string {
  return session ? session.key : "";
}

