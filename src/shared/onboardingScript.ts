// Jordan's interview answers for the onboarding demo (docs/STAGE-10.md), keyed by the recorded interview's
// question ids. Hand-written and synthetic, like Jordan; written after the interview was recorded, since
// they answer its questions. The page's DEMO REPLY fills the box with them; the recorder replays them.
export const ONBOARDING_ANSWERS: Record<string, string> = {
  q1: "Hard rule, yes. date-fns was a mistake: it was small, so I said yes without thinking. Don't rip it out in the middle of the launch, though. Put it on the list for after v2 ships, and replace it with ten lines of our own.",
  q2: "Anything that touches customer money or customer data. Retries are plumbing, so that one was easy. If a wrong call means a customer sees a wrong number or loses something, go slow and show me the worst case.",
  q3: "Access: never on your own, ever. Meetings aren't a hard rule. If it's a real debate, a meeting is fine. But start with a short written summary I can comment on, and book time only if the comments don't settle it.",
};
