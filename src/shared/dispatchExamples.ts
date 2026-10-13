// The public Dispatch demo's three tasks (docs/STAGE-8.md), in Jordan's words. Recorded by
// scripts/record.ts against live Claude, so the demo replays them for free; the page offers each as a
// DEMO chip. Every person, tool and task here is synthetic.

import type { Report } from "./dispatch";

export interface DispatchExample {
  id: string;
  /** The chip's label. */
  label: string;
  task: string;
  /** What the session reported, shown after Copy command as a labeled synthetic example. */
  report?: Omit<Report, "at"> & { minutes: number; asks: number };
}

export const DISPATCH_EXAMPLES: DispatchExample[] = [
  {
    id: "usage-demo",
    label: "Usage dashboard demo",
    task: "Spin up a quick demo of the usage dashboard for Thursday's review, so the team can click around the three charts we sketched last week.",
    report: {
      outcome: "done",
      scope: "as briefed",
      summary: "Three charts on fixed sample data, one page, runs with npm run dev. No auth or tests beyond one smoke run, as briefed.",
      minutes: 38,
      asks: 1,
    },
  },
  {
    id: "billing-complaints",
    label: "Billing complaints",
    task: "Go through last quarter's support tickets and pull out the billing complaints, grouped by what went wrong. No rush, any time this week.",
  },
  {
    id: "pagerduty",
    label: "Release bot → PagerDuty",
    task: "Hook the release bot up to PagerDuty so a failed release pages whoever is on call.",
  },
];
