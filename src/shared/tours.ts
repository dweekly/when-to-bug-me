// The guided tours: one catalog, used by the app's Tours menu, the explainer's tour cards, the
// recorder (every model call a tour makes is recorded) and the tests. Each tour is an exact script
// over the real app, starting from a fresh morning. A step points at an element, says one or two
// short sentences, and finishes when the visitor does the thing (a click on the real UI, or an
// expected element appearing), never by the tour doing it for them.

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
  /** Offer Jordan's words for this textarea: a recorded example's reason (by decision), or a literal
   *  sentence for steps that call no model. Labeled; for a recorded reason, offered only when live
   *  calls are off. */
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
  /** Decisions this tour answers or sets aside, in order, with the choice it asks for. Used by
   *  the recorder and the coverage test; the steps below must match. */
  path: { decision: string; choice?: string; reason?: "example"; keep?: boolean; setAside?: boolean }[];
  steps: TourStep[];
}

const pick = (key: string) => `#now .opt:nth-of-type(${key.charCodeAt(0) - 64})`;
const DECIDE = "#now .actions .primary";

export const TOURS: Tour[] = [
  {
    id: "start-here",
    title: "Start here",
    blurb: "The overview, one decision where you say no and why, and one you set aside.",
    minutes: 2,
    mood: "attentive",
    path: [
      { decision: "onsite-flight", choice: "B", reason: "example", keep: true },
      { decision: "berlin-sync", setAside: true },
    ],
    steps: [
      { go: "#/", target: ".sky", title: "Your night", text: "Every star is a question your agents raised overnight. Lit ones are already handled; dim ones wait on you.", until: "next" },
      { target: "#overnight", title: "Sorted three ways", text: "○ settled for you, ◐ a quick check, ● a real decision.", until: "next" },
      { go: "#/d/onsite-flight", target: "#now .why", title: "Code said no", text: "Claude would have booked the cheap 6:05am itself. Code stopped it: $212 and only partly refundable.", until: "next" },
      { target: "#now .viz", title: "See it, don't read it", text: "The briefing is a picture of the trade-off: the 6:05 lands before the 10:00 start.", until: "next" },
      { target: pick("B"), title: "Say no", text: "Answer as Jordan would: take the 9:40.", until: { click: pick("B") } },
      { target: DECIDE, title: "Decide", text: "Bug Me's guess stays sealed until you do.", until: { click: DECIDE } },
      { target: "#now .followup.push", optional: true, title: "Pushback, from your own rules", text: "Your travel rule says cheapest. Bug Me asks once. Say this one's an exception.", until: { click: "#now .followup.push .primary" } },
      { target: "#now .followup", title: "I'm curious: why?", text: "Your answer surprised it. Say why, or use Jordan's words.", until: { appear: "#fact-text" }, example: { textarea: "#why", decision: "onsite-flight" } },
      { target: "#now .followup", title: "A reason becomes guidance", text: "Keep it (edit it first if you like), and every agent gets it.", until: { appear: "#now .rerouted, #now .followup .senddown" } },
      { target: "#now .rerouted", title: "It travels", text: "The 7:30am Berlin invite was checked again under your new guidance.", until: { click: "#now .rerouted button" } },
      { target: "#now .actions .ghost", title: "Not now", text: "Not sure yet? Set it aside, and say what you'd need.", until: { click: "#now .actions .ghost" } },
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
    path: [{ decision: "onsite-flight", choice: "B", reason: "example", keep: true }],
    steps: [
      { go: "#/d/onsite-flight", target: "#now .why", title: "Code said no", text: "Claude would have settled this; code brought it to you: it costs $212 and is only partly refundable.", until: "next" },
      { target: pick("B"), title: "Say no", text: "Take the 9:40.", until: { click: pick("B") } },
      { target: DECIDE, title: "Decide", text: "Bug Me has a guess, sealed until you answer.", until: { click: DECIDE } },
      { target: "#now .followup.push", optional: true, title: "Pushback, from your own rules", text: "Your travel rule says cheapest. Bug Me asks once. Say this one's an exception.", until: { click: "#now .followup.push .primary" } },
      { target: "#now .followup", title: "I'm curious: why?", text: "Say why, or use Jordan's words.", until: { appear: "#fact-text" }, example: { textarea: "#why", decision: "onsite-flight" } },
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
    path: [{ decision: "api-rename", choice: "B", reason: "example", keep: true }],
    steps: [
      { go: "#/d/api-rename", target: "#now .why", title: "Why it's yours", text: "Your written rule says public API changes are yours.", until: "next" },
      { target: "#now .viz", title: "The real payload", text: "What changes, and who parses it.", until: "next" },
      { target: pick("B"), title: "Keep user_id", text: "Choose the stable name.", until: { click: pick("B") } },
      { target: "#basis", side: "top", title: "Say why", text: "Speak or type; it becomes guidance. Or use Jordan's words.", until: { click: DECIDE }, example: { textarea: "#basis", decision: "api-rename" } },
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
      { go: "#/d/sdk-dependency", target: pick("A"), title: "Take the agent's pick", text: "Add the library.", until: { click: pick("A") } },
      { target: DECIDE, title: "Decide", text: "Bug Me checks your record first.", until: { click: DECIDE } },
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
    path: [{ decision: "settings-redesign", choice: "B", reason: "example", keep: true }],
    steps: [
      { go: "#/d/settings-redesign", target: "#now .variants", title: "Both built", text: "Click around in each. They're real prototypes, not screenshots.", until: "next" },
      { target: pick("B"), title: "Pick one", text: "One page.", until: { click: pick("B") } },
      { target: "#basis", side: "top", title: "Teach it back", text: "In a sentence: what happens next if you choose it? Or use Jordan's words.", until: { click: DECIDE }, example: { textarea: "#basis", decision: "settings-redesign" } },
      { target: "#now .followup", title: "Guidance", text: "Keep it (edit it first if you like).", until: { appear: "#now .followup .senddown" } },
    ],
  },
  {
    id: "translate",
    title: "Lost in translation",
    blurb: "An agent's private jargon, restated in your terms.",
    minutes: 1,
    mood: "attentive",
    path: [{ decision: "reconciliation-path", choice: "B", reason: "example", keep: true }],
    steps: [
      { go: "#/d/reconciliation-path", target: "#now-q", title: "In your terms", text: "What the decision actually means for customers.", until: "next" },
      { target: "#now details.more", title: "What the agent asked", text: "Open it: “v2 reconciliation path or the T-19 mapping?”", until: { click: "#now details.more summary" } },
      { target: pick("B"), title: "Decide", text: "Leave past invoices alone.", until: { click: pick("B") } },
      { target: "#basis", side: "top", title: "Say why", text: "Or use Jordan's words.", until: { click: DECIDE }, example: { textarea: "#basis", decision: "reconciliation-path" } },
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
      { go: "#/settled", target: "#settled", title: "Decided for you", text: "Housekeeping your rules cleared. Each can be undone.", until: "next" },
      { target: "#settled li:first-child .marks button:first-child", title: "Undo", text: "Undo one: it comes back to you.", until: { click: "#settled li:first-child .marks button:first-child" } },
      { target: "#settled li:first-child .marks", title: "Two kinds of wrong", text: "“You should have asked me” is about routing; “right to decide, wrong call” is about judgment. They're kept apart.", until: "next" },
    ],
  },
];

export const TOUR_IDS = new Set(TOURS.map((t) => t.id));
