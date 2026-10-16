// Jordan's interview answers for the onboarding demo (docs/STAGE-10.md), keyed by the recorded interview's
// question ids. Hand-written and synthetic, like Jordan; written after the interview was recorded, since
// they answer its questions. The page's DEMO REPLY fills the box with them; the recorder replays them.
export const ONBOARDING_ANSWERS: Record<string, string> = {
  q1: "No new libraries in the SDKs, ever. Every customer installs whatever we add. date-fns was a mistake, but don't rip it out in the middle of the launch. Put it on the list for after v2 ships, and replace it with a few lines of our own.",
  q2: "Yes, just do it. Formatting, lint, merged branches and patch bumps: don't ask me. Anything bigger than a patch, or anything that changes what customers get, still comes to me.",
  q3: "Close. A new meeting gets a one-page write-up first, and we book time only if the comments don't settle it. Regular ones I already go to, just accept. But nothing before 8:30. I do school drop-off, so accepting the 7:30 Berlin call was a mistake.",
};
