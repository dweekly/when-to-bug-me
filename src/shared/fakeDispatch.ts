// The deterministic stand-in for the dispatch prompt (docs/STAGE-8.md), used for tests and with
// FAKE_MODEL. Keyword matching, not judgment: it exists so the page and the Worker can be tested
// through their real entry points without a key.

import type { Catalog } from "./dispatch";

export function fakeDispatch(task: string, answers: string, c: Catalog): Record<string, unknown> {
  const t = `${task} ${answers}`.toLowerCase();
  const quick = /\b(quick|demo|prototype|try|spike|mock)\b/.test(t);
  const sensitive = /\b(customer|support tickets?|email|health|salary|private|personal|password)\b/.test(t);
  const urgent = /\b(today|urgent|asap|now|tonight)\b/.test(t);
  const wantsCredentials = /\b(token|api key|connect|integrat\w*)\b|\bhook\b.*\bup\b/.test(t);
  const words = task.trim().split(/\s+/);
  const prefixes = c.servers.map((s) => s.prefix);
  const chatty = prefixes.filter((p) => /slack|mail|calendar/i.test(p));
  return {
    headline: words.slice(0, 6).join(" ").replace(/[.?!]$/, ""),
    goal: task.trim().slice(0, 200),
    why: "So the person can react to something real.",
    questions: answers || words.length > 6 ? [] : ["Who is this for, and by when?"],
    stage: quick ? "prototype" : "mvp",
    done: ["It runs from one command", "One smoke check passes"],
    out_of_scope: quick ? ["Authentication", "Tests beyond one smoke run", "A production deploy"] : ["A production deploy"],
    estimate_minutes: quick ? 30 : 90,
    budget_usd: quick ? 2 : 6,
    model: "claude-opus-5-5",
    effort: quick ? "low" : "medium",
    permission_mode: sensitive ? "manual" : "auto",
    sensitivity: sensitive ? "high" : "low",
    sensitivity_reason: sensitive ? "It reads customer or private data." : "Internal code only.",
    urgency: urgent ? "high" : "low",
    urgency_reason: urgent ? "Needed today." : "It can wait a day.",
    tools_off: sensitive ? chatty : [],
    tools_needed: c.servers.filter((s) => t.includes(s.name.toLowerCase())).map((s) => s.prefix),
    skills: [],
    context: [],
    guidance: [],
    prerequisites: wantsCredentials ? [{ what: "Hand over the API token", why: "The session can't create one itself." }] : [],
    check_ins: ["Anything that spends real money"],
  };
}
