// The guided tours: one catalog, used by the app's Tours menu, the explainer's tour cards, the
// recorder (every model call a tour makes is recorded) and the tests. Each tour is an exact script
// over the real app, starting from a fresh morning. A step points at an element, says one or two
// short sentences, and finishes when the visitor does the thing (a click on the real UI, or an
// expected element appearing), never by the tour doing it for them.

import { DISPATCH_EXAMPLES } from "./dispatchExamples";
import { ONBOARDING_ANSWERS } from "./onboardingScript";

export interface TourStep {
  /** Navigate here before the step (a hash like "#/d/onsite-flight"). */
  go?: string;
  /** What to highlight: a CSS selector, re-found after every render. */
  target: string;
  title: string;
  text: string;
  /** How the step finishes: the visitor clicks something matching this selector, an element
   *  matching it appears, or they press Next. */
  until: { click: string } | { appear: string } | { event: string } | "next";
  /** Which side of the target the popover sits on, when it must not cover what the visitor clicks next. */
  side?: "top" | "bottom" | "left" | "right";
  /** A step that may not happen on this path (pushback is rationed and depends on the record):
   *  if its target hasn't appeared within a moment, the tour skips it. */
  optional?: boolean;
  /** Offer Jordan's words for this textarea: a recorded example (by decision: its scripted turn for the
   *  conversation box, its reason for the "why?" box), or a literal sentence for steps that call no
   *  model. Labeled; offered on live servers too, since recorded words replay for free. */
  example?: { textarea: string; decision?: string; text?: string };
}

export interface Tour {
  id: string;
  title: string;
  /** One line on the tour card: what you'll see. */
  blurb: string;
  minutes: number;
  /** Firefly mood shown on the tour card. */
  mood: "attentive" | "pleased" | "delighted" | "sheepish" | "resting";
  /** Decisions this tour answers or sets aside, in order, with the choice it asks for. `narration`:
   *  Jordan's recorded words go in the think box; `reason`: Jordan's recorded reason answers "why?".
   *  Used by the coverage test; the steps below must match. */
  path: { decision: string; choice?: string; narration?: true; reason?: "example"; keep?: boolean; setAside?: boolean }[];
  steps: TourStep[];
}

const pick = (key: string) => `#now .opt[data-key="${key}"]`;
/** One of Jordan's turns in the conversation: say it (or use Jordan's words, the decision's scripted
 *  turn), then Send. Finishes when Bug Me's reply to that turn (the `turn`th) appears. */
const say = (decision: string, turn: number, title: string, text: string): TourStep => ({
  // The box, with the popover above it: on a phone a tall thread would otherwise put it over Send.
  target: "#now .composer",
  side: "top",
  title,
  text,
  until: { appear: `#now .turns li.bug:not(.typing):nth-child(${turn * 2})` },
  example: { textarea: "#think", decision },
});
/** Bug Me read the decision back: the button is the decision itself. Moves on when the answer goes
 *  down the usual path (pushback, the guess, guidance or done). */
const decide = (text = "Bug Me read it back. The button is the decision itself: press it."): TourStep => ({
  target: "#now .send.decide",
  title: "Decide",
  text,
  until: { appear: "#now .followup" },
});

export const TOURS: Tour[] = [
  {
    id: "start-here",
    title: "Start here",
    blurb: "Your queue in order, one decision where you say no and why, and one you set aside.",
    minutes: 2,
    mood: "attentive",
    path: [
      { decision: "onsite-flight", choice: "B", narration: true, reason: "example", keep: true },
      { decision: "berlin-sync", setAside: true },
    ],
    steps: [
      { go: "#/", target: "#start-card", title: "Start here", text: "Bug Me sorted last night's questions into piles, one per project. It suggests this one first, and says why.", until: "next" },
      { target: "#agenda", title: "Then, in order", text: "Every waiting question in the order to work it. ● a real decision, ◐ a quick check.", until: "next" },
      { go: "#/d/onsite-flight", target: "#now .why", title: "Code said no", text: "Claude would have booked the cheap 6:05am itself. Code stopped it: $212 and only partly refundable.", until: "next" },
      { target: "#now .viz", title: "See it, don't read it", text: "A picture of the trade-off: the 6:05 lands before the 10:00 start. Each option lists its pros, cons and cost.", until: "next" },
      say("onsite-flight", 1, "Talk to Bug Me", "Say it the way you'd say it to a colleague: take the 9:40. Then Send. Or press DEMO REPLY."),
      say("onsite-flight", 2, "One light question", "A bare pick earns one question: why? Answer it, or press DEMO REPLY."),
      decide("Bug Me read it back. The button is the decision itself, and its guess is still sealed: press it."),
      { target: "#now .followup", title: "A reason becomes guidance", text: "Now you see what the agent recommended and what Bug Me expected you to choose. Keep your reason (edit it first if you like), and every agent gets it.", until: { appear: "#now .rerouted, #now .followup .senddown" } },
      { target: "#now .rerouted", title: "It travels", text: "The 7:30am Berlin invite was checked again under your new guidance.", until: { click: "#now .rerouted button" } },
      { target: "#now .skip-q", title: "Skip", text: "Not ready to decide? Set it aside, and say what you'd need.", until: { click: "#now .skip-q" } },
      { target: "#now .punt", title: "What would you need?", text: "Pick one and say it in a sentence. The agent is told exactly that.", until: { event: "bugme:set-aside" }, example: { textarea: "#punt-reason", text: "Ask the Berlin team whether 9:30am Pacific works; that's still 18:30 for them." } },
      { go: "#/", target: "#aside", title: "Set aside, not lost", text: "Back on the overview, it waits here with your reason until you resume it.", until: "next" },
    ],
  },
  {
    id: "say-why",
    title: "Say no, and say why",
    blurb: "Code overrules Claude, a sealed guess, and a reason that changes another decision.",
    minutes: 1,
    mood: "pleased",
    path: [{ decision: "onsite-flight", choice: "B", narration: true, reason: "example", keep: true }],
    steps: [
      { go: "#/d/onsite-flight", target: "#now .why", title: "Code said no", text: "Claude would have settled this; code brought it to you: it costs $212 and is only partly refundable.", until: "next" },
      say("onsite-flight", 1, "Say no", "Take the 9:40, then Send. Or press DEMO REPLY."),
      say("onsite-flight", 2, "Say why", "Bug Me asks why, once. Answer it, or press DEMO REPLY."),
      decide("Bug Me's guess stays sealed until you decide."),
      { target: "#now .followup", title: "Guidance", text: "Keep it (edit it first if you like).", until: { appear: "#now .followup .senddown" } },
      { target: "#now .rerouted", title: "It travels", text: "The weekly 7:30am invite is now framed by what you said.", until: "next" },
    ],
  },
  {
    id: "rule-quoted",
    title: "Your rule, quoted",
    blurb: "A public API change: your own rule decides it's yours, and your reason reaches the webhooks.",
    minutes: 1,
    mood: "attentive",
    path: [{ decision: "api-rename", choice: "B", narration: true, keep: true }],
    steps: [
      { go: "#/d/api-rename", target: "#now .why", title: "Why it's yours", text: "Your written rule says public API changes are yours.", until: "next" },
      { target: "#now .options", title: "Each option, whole", text: "Each card holds its own line of the real payload, its pros and its cons.", until: "next" },
      say("api-rename", 1, "Talk it through", "Which way, why, any “but…”, any question, in one go. Then Send. Or press DEMO REPLY."),
      { target: "#now .turns", title: "Heard, in your words", text: "Bug Me marks what it heard: the choice, the reasons, the condition, the question. Then it reads the decision back.", until: "next" },
      decide("The reason and the condition go with it, in your words."),
      { target: "#now .followup", title: "Guidance", text: "Keep it (edit it first if you like).", until: { appear: "#now .followup .senddown" } },
      { target: "#now .rerouted", title: "It travels", text: "The webhook rename is now framed by your reason.", until: "next" },
    ],
  },
  {
    id: "pushback",
    title: "Pushback from your own record",
    blurb: "You pick the agent's suggestion; Bug Me quotes what you said last week.",
    minutes: 1,
    mood: "attentive",
    path: [{ decision: "sdk-dependency", choice: "B" }],
    steps: [
      { go: "#/d/sdk-dependency", target: pick("A"), title: "Add the library", text: "Click it. Clicking picks; nothing goes out yet.", until: { click: pick("A") } },
      { target: "#now .send", title: "Send", text: "Send the click on its own.", until: { appear: "#now .turns li.bug:not(.typing):nth-child(2)" } },
      say("sdk-dependency", 2, "Just do it", "A bare click earns one question. Tell Bug Me to just do it, or press DEMO REPLY."),
      decide("Bug Me checks your record before it goes out."),
      { target: "#now .followup.push", title: "Your own words", text: "It quotes what you told it last week. Change your answer.", until: { click: "#now .followup.push .ghost" } },
      { target: "#now .followup", title: "Pushback, rationed", text: "At most twice a session, and only with your own record.", until: "next" },
    ],
  },
  {
    id: "explore",
    title: "See it before you choose",
    blurb: "Two clickable versions of a redesign, side by side, and a one-sentence teach-back.",
    minutes: 1,
    mood: "delighted",
    path: [{ decision: "settings-redesign", choice: "B", narration: true, keep: true }],
    steps: [
      { go: "#/d/settings-redesign", target: "#now .options", title: "Both built", text: "Click around in each. They're real prototypes, not screenshots.", until: "next" },
      say("settings-redesign", 1, "Teach it back", "Pick one and say what happens next on that page, then Send. Or press DEMO REPLY."),
      decide(),
      { target: "#now .followup", title: "Guidance", text: "Keep it (edit it first if you like).", until: { appear: "#now .followup .senddown" } },
    ],
  },
  {
    id: "translate",
    title: "Lost in translation",
    blurb: "An agent's private jargon, restated in your terms.",
    minutes: 1,
    mood: "attentive",
    path: [{ decision: "reconciliation-path", choice: "B", narration: true, keep: true }],
    steps: [
      { go: "#/d/reconciliation-path", target: "#now-q", title: "In your terms", text: "What the decision actually means for customers.", until: "next" },
      { target: "#now details.more", title: "What the agent asked", text: "Open it: “v2 reconciliation path or the T-19 mapping?”", until: { click: "#now details.more summary" } },
      // docs/STAGE-6E.md: the press is the turn; the tour moves on when Bug Me has said it again, plainly.
      { target: "#now .huh-row .huh", title: "Still unclear?", text: "Press Huh? and Bug Me says it again, more plainly.", until: { appear: "#now .turns li.bug.explain" } },
      { target: "#now .turns li.bug.explain", title: "In plain terms", text: "Said again, plainly. A Huh? also tells Bug Me its translation missed.", until: "next" },
      say("reconciliation-path", 2, "Decide out loud", "Leave past invoices alone, and say why. Then Send. Or press DEMO REPLY."),
      decide(),
      { target: "#now .followup", title: "Guidance", text: "Keep it (edit it first if you like).", until: { appear: "#now .followup .senddown" } },
    ],
  },
  {
    id: "decided",
    title: "What Bug Me decided for you",
    blurb: "Only what's reversible, cheap and cleared by your rules. Undo, or say where it went wrong.",
    minutes: 1,
    mood: "sheepish",
    path: [],
    steps: [
      { go: "#/settled", target: "#settled", title: "Decided for you", text: "Small jobs your rules already cover, grouped by kind. Each can be undone.", until: "next" },
      { target: "#settled .dgroup:first-of-type > summary", title: "Open a group", text: "Open one to see each job.", until: { click: "#settled .dgroup:first-of-type > summary" } },
      { target: "#settled .dgroup[open] .drow:first-child .dundo", title: "Undo", text: "Undo one: it comes back to you.", until: { click: "#settled .dgroup[open] .drow:first-child .dundo" } },
      { target: "#settled .dgroup[open] .drow:first-child .dacts", title: "Two kinds of wrong", text: "Ask! says it should have come to you; Disagree says right to decide, wrong call. They're kept apart.", until: "next" },
    ],
  },
  {
    id: "dispatch",
    title: "Send work out at the right size",
    blurb: "A rough task becomes a brief: sized, fenced in, with what it needs from you first.",
    minutes: 1,
    mood: "attentive",
    path: [],
    steps: [
      {
        go: "#/dispatch",
        target: ".dispatch-new",
        // Above the box: on a phone, below it would cover Draft brief.
        side: "top",
        title: "Say what you want done",
        text: "Say it or type it, the way you'd tell a colleague. Then Draft brief.",
        until: { click: "#draft-brief" },
        example: { textarea: "#dispatch-task", text: DISPATCH_EXAMPLES[0].task },
      },
      { target: "#brief .brief-meta", title: "Sized first", text: "A stage, an estimate, and a stop at twice it, where the session asks instead of growing the job.", until: "next" },
      { target: "#brief .brief-skip", title: "Not this time", text: "What it would be tempted to build. Ruled out.", until: "next" },
      { target: "#brief .brief-you", title: "You first", text: "What would stop it halfway. Tick it off.", until: { click: "#brief .brief-you input" } },
      { target: "#copy-command", title: "Copy and run", text: "One command: model, effort, tools off, and the brief. The setup is under Details.", until: { click: "#copy-command" } },
      // Only after a copy that worked (a browser can refuse the clipboard): otherwise the tour ends here.
      { target: ".brief-report", optional: true, title: "It reports back", text: "How it went, next to what was briefed.", until: "next" },
    ],
  },
  {
    id: "welcome",
    title: "Getting to know you",
    blurb: "Bug Me reads Jordan's past decisions, writes down the rules Jordan seems to follow, and asks about the ones it isn't sure of.",
    minutes: 2,
    mood: "pleased",
    path: [],
    steps: [
      { go: "#/welcome", target: "#step-read", title: "It reads first", text: "Bug Me read Jordan's past decisions on its own: how fast Jordan answered, what Jordan typed, and where Jordan overruled the agent.", until: "next" },
      { target: "#step-draft .wnote", title: "Each rule shows why", text: "Each rule it found lists the decisions behind it. Open one.", until: { click: "#step-draft .cites" } },
      { target: "#step-interview .iq:nth-child(1)", side: "top", title: "Then it asks", text: "Only about the rules it isn't sure of. Say your answer, or use Jordan's.", until: "next", example: { textarea: "#answer-q1", text: ONBOARDING_ANSWERS.q1 } },
      { target: "#step-interview .iq:nth-child(2)", side: "top", title: "Where it's unsure", text: "Jordan's answer to the second.", until: "next", example: { textarea: "#answer-q2", text: ONBOARDING_ANSWERS.q2 } },
      { target: "#step-interview .iq:nth-child(3)", side: "top", title: "Is it a rule?", text: "It checks a pattern before writing it down. Jordan's answer.", until: "next", example: { textarea: "#answer-q3", text: ONBOARDING_ANSWERS.q3 } },
      { target: "#revise-note", title: "Update the rules", text: "The answers change the rules.", until: { click: "#revise-note" } },
      { target: "#step-note", title: "The rules it works from", text: "What changed, and why, in Jordan's words.", until: "next" },
    ],
  },
];

export const TOUR_IDS = new Set(TOURS.map((t) => t.id));
