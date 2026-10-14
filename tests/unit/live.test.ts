// The live queue (docs/STAGE-7.md): an agent's ask becomes a Decision, tickets move through their
// lifecycle, only the owner gets in, and nothing from the live queue can reach a recording or the cache.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Card } from "../../src/shared/types";
import { enforceSettleInvariant } from "../../src/shared/route";
import type { RouteOutput } from "../../src/shared/types";
import {
  AskError,
  LiveQueue,
  OWNER_RULES,
  OWNER_SETTLE_LIMITS,
  UNKNOWN_COST_USD,
  decisionFromAsk,
  grantsPermission,
  mapKV,
  ownerPersona,
  parseResolution,
  reply,
  reservesDecision,
  waitingMinutes,
} from "../../src/worker/live";
import { MIN_TOKEN_CHARS, OWNER_COOKIE, cookieValue, isOwner, ownerCookie, readCookie, sameString } from "../../src/worker/liveAuth";

const ASK = {
  question: "Deploy the new onboarding flow to production now?",
  options: [
    { label: "Deploy now", pros: "users get it today", reversible: "partly", cost_usd: 0 },
    { label: "Wait for Monday", cons: "a weekend of the old flow", reversible: "yes", cost_usd: 0 },
  ],
  recommended: "Deploy now",
  context: "Staging passed; this is the production deploy.",
  project: "tidepool",
  session: "onboarding work",
};

function cardFor(id: string, route: Card["route"], settle = ""): Card {
  return {
    id,
    route,
    model_route: route,
    settle_option: settle,
    reversible: "yes",
    cost: "cheap",
    clearing_rule: route === "settle" ? OWNER_RULES[2].text : "",
    rule_quoted: OWNER_RULES[1].text,
    fact_quoted: "",
    why_here: "Your rule says production deploys need your go.",
    headline: "Deploy onboarding to production now?",
    in_your_terms: "",
    problem: "fine",
    source: "code",
    sealed: "v1.x.y.z",
  };
}

describe("an ask becomes a decision", () => {
  it("keeps the agent's words and declared bounds, keyed A, B…", () => {
    const d = decisionFromAsk(ASK, "t-abc");
    expect(d.id).toBe("t-abc");
    expect(d.project).toBe("tidepool");
    // The decision carries the project's id, so the page's agenda finds it under the persona's projects.
    expect(decisionFromAsk({ ...ASK, project: "My App" }, "t-p").project).toBe("my-app");
    expect(decisionFromAsk({ ...ASK, project: undefined }, "t-p").project).toBe("other");
    expect(d.agent).toEqual(["onboarding work"]);
    expect(d.options.map((o) => o.key)).toEqual(["A", "B"]);
    expect(d.options[0].description).toBe("For: users get it today; The agent says: reversible: partly; costs $0");
    expect(d.options[1].description).toBe("Against: a weekend of the old flow; The agent says: reversible: yes; costs $0");
    expect(d.recommended).toBe("A");
    expect(d.bounds).toEqual({ A: { reversible: "partly", cost_usd: 0 }, B: { reversible: "yes", cost_usd: 0 } });
  });

  it("treats an undeclared reversibility or cost as irreversible and expensive, so it can never settle", () => {
    const d = decisionFromAsk({ ...ASK, options: [{ label: "Do it" }, { label: "Don't", reversible: "maybe", cost_usd: -3 }] }, "t-x");
    expect(d.bounds.A).toEqual({ reversible: "no", cost_usd: UNKNOWN_COST_USD });
    expect(d.bounds.B).toEqual({ reversible: "no", cost_usd: UNKNOWN_COST_USD });
  });

  it("refuses an ask without a question, or with too few or too many options", () => {
    expect(() => decisionFromAsk({ ...ASK, question: " " }, "t-x")).toThrow(AskError);
    expect(() => decisionFromAsk({ ...ASK, options: [ASK.options[0]] }, "t-x")).toThrow(AskError);
    expect(() => decisionFromAsk({ ...ASK, options: Array(4).fill(ASK.options[0]) }, "t-x")).toThrow(AskError);
  });

  it("names the owner's projects from the tickets, and is not marked synthetic", () => {
    const p = ownerPersona([{ id: "tidepool", name: "tidepool" }, { id: "lantern", name: "Lantern" }]);
    expect(p.synthetic).toBe(false);
    expect(p.projects.map((x) => x.id)).toEqual(["tidepool", "lantern"]);
  });
});

describe("the ticket lifecycle", () => {
  it("settles at once when a rule covers it, quoting the rule and the instruction", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-settle");
    const t = await q.add(d, cardFor(d.id, "settle", "B"), "Wait until Monday, then deploy.", 0);
    expect(reply(t)).toEqual({ status: "settled", ticket: "t-settle", choice: "B", label: "Wait for Monday", rule: OWNER_RULES[2].text, instruction: "Wait until Monday, then deploy." });
  });

  it("queues anything else as pending, then answers with the owner's choice and reason", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-open");
    expect(reply(await q.add(d, cardFor(d.id, "decide"), "", 0))).toMatchObject({ status: "pending", ticket: "t-open", route: "decide" });
    const r = parseResolution({ outcome: "option", choice: "B", reason: "Nobody's around to watch it this weekend.", instruction: "Deploy Monday morning." }, d);
    expect(reply(await q.resolve(d.id, r))).toEqual({
      status: "answered",
      ticket: "t-open",
      outcome: "option",
      choice: "B",
      label: "Wait for Monday",
      reason: "Nobody's around to watch it this weekend.",
      instruction: "Deploy Monday morning.",
    });
  });

  it("adds a later reason or kept guidance to the same answer", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-merge");
    await q.add(d, cardFor(d.id, "decide"), "", 0);
    await q.resolve(d.id, parseResolution({ outcome: "option", choice: "A", instruction: "Deploy now." }, d));
    await q.resolve(d.id, parseResolution({ outcome: "option", choice: "A", reason: "It's been on staging a week." }, d));
    const t = await q.resolve(d.id, parseResolution({ outcome: "option", choice: "A", guidance: "Friday deploys are fine when staging has soaked a week." }, d));
    expect(reply(t)).toMatchObject({ choice: "A", instruction: "Deploy now.", reason: "It's been on staging a week.", guidance: "Friday deploys are fine when staging has soaked a week." });
  });

  it("a follow-up (a late reason, guidance) is refused once the answer it belongs to has changed", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-follow");
    await q.add(d, cardFor(d.id, "decide"), "", 0);
    await q.resolve(d.id, parseResolution({ outcome: "option", choice: "A" }, d)); // this browser
    await q.resolve(d.id, parseResolution({ outcome: "option", choice: "B" }, d)); // another device, later
    await expect(q.resolve(d.id, parseResolution({ outcome: "option", choice: "A", reason: "late", update: true }, d))).rejects.toThrow(/changed/);
    expect(reply((await q.get(d.id))!)).toMatchObject({ choice: "B" });
    expect(reply((await q.get(d.id))!).reason).toBeUndefined();
    // A follow-up to the answer that stands still adds to it.
    expect(reply(await q.resolve(d.id, parseResolution({ outcome: "option", choice: "B", reason: "still B", update: true }, d)))).toMatchObject({ choice: "B", reason: "still B" });
  });

  it("a changed choice replaces the earlier answer rather than mixing them", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-change");
    await q.add(d, cardFor(d.id, "decide"), "", 0);
    await q.resolve(d.id, parseResolution({ outcome: "option", choice: "A", reason: "ship it" }, d));
    const t = await q.resolve(d.id, parseResolution({ outcome: "option", choice: "B" }, d));
    expect(reply(t)).toEqual({ status: "answered", ticket: "t-change", outcome: "option", choice: "B", label: "Wait for Monday" });
  });

  it("set aside and undo tell the session not to proceed", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-aside");
    await q.add(d, cardFor(d.id, "decide"), "", 0);
    expect(reply(await q.resolve(d.id, parseResolution({ outcome: "set-aside", reason: "Need the error rates first.", instruction: "Get last week's error rates." }, d)))).toMatchObject({
      status: "set-aside",
      instruction: "Get last week's error rates.",
    });
    const s = decisionFromAsk(ASK, "t-undo");
    await q.add(s, cardFor(s.id, "settle", "B"), "Wait.", 0);
    expect(reply(await q.resolve(s.id, parseResolution({ outcome: "reopened" }, s)))).toMatchObject({ status: "reopened" });
  });

  it("a re-route that now settles an open ticket answers it by rule; an answered one is left alone", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-re");
    await q.add(d, cardFor(d.id, "check_in"), "", 0);
    expect(reply((await q.reroute(d.id, cardFor(d.id, "settle", "A"), "Go.", 0))!)).toMatchObject({ status: "settled", choice: "A", instruction: "Go." });
    const e = decisionFromAsk(ASK, "t-done");
    await q.add(e, cardFor(e.id, "decide"), "", 0);
    await q.resolve(e.id, parseResolution({ outcome: "option", choice: "B" }, e));
    expect(reply((await q.reroute(e.id, cardFor(e.id, "settle", "A"), "Go.", 0))!)).toMatchObject({ status: "answered", choice: "B" });
  });

  it("the page sees open and reopened tickets and recent settled ones, never answered ones", async () => {
    const q = new LiveQueue(mapKV());
    const mk = async (id: string, route: Card["route"]) => {
      const d = decisionFromAsk(ASK, id);
      await q.add(d, cardFor(id, route, route === "settle" ? "A" : ""), "", 0);
      return d;
    };
    await mk("t-1", "decide");
    await mk("t-2", "settle");
    const a = await mk("t-3", "decide");
    await q.resolve(a.id, parseResolution({ outcome: "option", choice: "A" }, a));
    expect((await q.shown()).map((t) => t.decision.id).sort()).toEqual(["t-1", "t-2"]);
  });

  it("starts from the owner's rules, and keeps edits", async () => {
    const q = new LiveQueue(mapKV());
    expect((await q.context()).rules).toEqual(OWNER_RULES);
    await q.setContext([{ id: "L1", text: "Ask me everything." }], []);
    expect((await q.context()).rules).toEqual([{ id: "L1", text: "Ask me everything." }]);
  });

  it("clips an over-long reason rather than refusing it, so a delivery can never jam", () => {
    const d = decisionFromAsk(ASK, "t-long");
    const r = parseResolution({ outcome: "set-aside", reason: "x".repeat(2000), instruction: "y".repeat(2000) }, d);
    expect(r.reason!.length).toBe(1200);
    expect(r.instruction!.endsWith("…")).toBe(true);
  });

  it("keeps answered tickets for a day, so a late reason or guidance still has its decision", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-recent");
    await q.add(d, cardFor(d.id, "decide"), "", 0);
    await q.resolve(d.id, parseResolution({ outcome: "option", choice: "A" }, d), new Date("2026-10-12T10:00:00Z"));
    expect((await q.recentlyAnswered(new Date("2026-10-12T20:00:00Z"))).map((t) => t.decision.id)).toEqual(["t-recent"]);
    expect(await q.recentlyAnswered(new Date("2026-10-14T10:00:00Z"))).toEqual([]);
  });

  it("saves and reads the rules and their revision in one step", async () => {
    const q = new LiveQueue(mapKV());
    const s = await q.snapshot([{ id: "L1", text: "Ask me everything." }], []);
    expect(s).toMatchObject({ rev: 1, rules: [{ id: "L1", text: "Ask me everything." }] });
    expect((await q.snapshot()).rev).toBe(1);
  });

  it("refuses a resolution that names no option, or an other without a course", () => {
    const d = decisionFromAsk(ASK, "t-bad");
    expect(() => parseResolution({ outcome: "option", choice: "Z" }, d)).toThrow(AskError);
    expect(() => parseResolution({ outcome: "other" }, d)).toThrow(AskError);
    expect(() => parseResolution({ outcome: "maybe" }, d)).toThrow(AskError);
  });

  it("counts waiting minutes from when it was asked", () => {
    const t = { created_at: "2026-10-12T10:00:00.000Z" } as Parameters<typeof waitingMinutes>[0];
    expect(waitingMinutes(t, new Date("2026-10-12T10:07:30.000Z"))).toBe(8);
  });
});

describe("only the owner gets in", () => {
  const liveKey = "x".repeat(MIN_TOKEN_CHARS);
  const req = (headers: Record<string, string>) => new Request("https://bugme.example/api/me/queue", { headers });

  it("accepts the bearer token or the owner cookie, and nothing else", async () => {
    expect(await isOwner(req({ authorization: `Bearer ${liveKey}` }), liveKey)).toBe(true);
    expect(await isOwner(req({ cookie: `a=b; ${OWNER_COOKIE}=${await cookieValue(liveKey)}` }), liveKey)).toBe(true);
    expect(await isOwner(req({ authorization: `Bearer ${liveKey}x` }), liveKey)).toBe(false);
    expect(await isOwner(req({ cookie: `${OWNER_COOKIE}=${liveKey}` }), liveKey)).toBe(false);
    expect(await isOwner(req({}), liveKey)).toBe(false);
  });

  it("is off entirely without a long enough token", async () => {
    expect(await isOwner(req({ authorization: "Bearer short" }), "short")).toBe(false);
    expect(await isOwner(req({ authorization: "Bearer " }), undefined)).toBe(false);
  });

  it("sets a cookie that can't be read by the page or sent cross-site, holding an HMAC rather than the token", async () => {
    const c = await ownerCookie(liveKey);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Strict");
    expect(c).not.toContain(liveKey);
    expect(readCookie(c.split(";")[0], OWNER_COOKIE)).toBe(await cookieValue(liveKey));
  });

  it("compares in constant time, but correctly", () => {
    expect(sameString("abc", "abc")).toBe(true);
    expect(sameString("abc", "abd")).toBe(false);
    expect(sameString("abc", "abcd")).toBe(false);
  });
});

describe("nothing from the live queue reaches a recording or the cache", () => {
  it("the recorder and the evals import nothing from the live queue", () => {
    // smoke-dispatch.ts and smoke-runner.ts drive the owner's API on purpose, against a throwaway local
    // Worker (or runner) only; onboard.ts sends the owner's own history to their own runner, nowhere else.
    for (const f of readdirSync("scripts").filter((x) => x.endsWith(".ts") && !["smoke-dispatch.ts", "smoke-runner.ts", "onboard.ts"].includes(x))) {
      const src = readFileSync(`scripts/${f}`, "utf8");
      expect(src, f).not.toMatch(/worker\/(live|owner|liveAuth)|\/api\/me\//);
    }
  });

  it("every read and write of the recorded run and the response cache is behind the store flag", () => {
    const src = readFileSync("src/worker/model.ts", "utf8");
    expect(src).toMatch(/const rec = store \? RECORDED\[key\] : undefined;/);
    expect(src).toMatch(/const hit = store \? await cache\.match\(cacheUrl\(key\)\) : undefined;/);
    expect(src).toMatch(/if \(store\) await cache\.put\(/);
    expect(src.match(/cache\.(put|match)\(/g)).toHaveLength(2);
    expect(src.match(/RECORDED\[/g)).toHaveLength(1);
  });

  it("the owner's world never stores", () => {
    const src = readFileSync("src/worker/index.ts", "utf8");
    const owner = src.slice(src.indexOf("async function ownerWorld"));
    expect(owner).toMatch(/store: false/);
    expect(src.match(/store: false/g)!.length).toBeGreaterThanOrEqual(2); // the world, and a new ticket's routing
  });
});

describe("what Bug Me may settle on the owner's behalf", () => {
  const rule = (id: string) => OWNER_RULES.find((r) => r.id === id)!.text;
  const route = (clearing: string, rule_quoted = ""): RouteOutput => ({
    route: "settle",
    settle_option: "A",
    reversible: "yes",
    cost: "cheap",
    clearing_rule: clearing,
    rule_quoted,
    fact_quoted: "",
    why_here: "",
    headline: "",
    in_your_terms: "",
    briefing: "",
    option_notes: [],
    problem: "fine",
    guess: [],
    conflicts: [],
    send_down: [],
  });
  const ask = (cost: number) => decisionFromAsk({ ...ASK, options: [{ label: "Do it", reversible: "yes", cost_usd: cost }, { label: "Don't", reversible: "yes", cost_usd: 0 }] }, "t-s");

  it("only rules that grant permission can clear; rules that keep something for David can't", () => {
    expect(OWNER_RULES.filter((r) => grantsPermission(r.text)).map((r) => r.id)).toEqual(["L3", "L4", "L10"]);
    for (const id of ["L2", "L5", "L6"]) expect(reservesDecision(rule(id)), id).toBe(true);
  });

  it("settles a free, reversible staging deploy under the staging rule", () => {
    expect(enforceSettleInvariant(route(rule("L3")), ask(0), OWNER_RULES, [], OWNER_SETTLE_LIMITS).route).toBe("settle");
  });

  it("stops at about a dollar, not the simulation's $50", () => {
    expect(enforceSettleInvariant(route(rule("L4")), ask(1), OWNER_RULES, [], OWNER_SETTLE_LIMITS).route).toBe("settle");
    expect(enforceSettleInvariant(route(rule("L4")), ask(20), OWNER_RULES, [], OWNER_SETTLE_LIMITS).route).toBe("check_in");
  });

  it("never treats a rule that needs David's go as permission", () => {
    const r = enforceSettleInvariant(route(rule("L2")), ask(0), OWNER_RULES, [], OWNER_SETTLE_LIMITS);
    expect(r.route).toBe("check_in");
    expect(r.adjusted).toMatch(/doesn't let Bug Me act alone/);
  });

  it("a general permission loses to a rule that keeps the decision for David", () => {
    const r = enforceSettleInvariant(route(rule("L10"), rule("L5")), ask(0), OWNER_RULES, [], OWNER_SETTLE_LIMITS);
    expect(r.route).toBe("check_in");
    expect(r.adjusted).toMatch(/keeps this for you/);
  });

  it("a partial quote of a reserving rule still keeps the decision for David", () => {
    const r = enforceSettleInvariant(route(rule("L10"), "deploys need my explicit go."), ask(0), OWNER_RULES, [], OWNER_SETTLE_LIMITS);
    expect(r.route).toBe("check_in");
  });

  it("the simulation's limits are unchanged", () => {
    expect(enforceSettleInvariant(route(rule("L4")), ask(20), OWNER_RULES).route).toBe("settle");
  });
});

describe("races and returns", () => {
  it("a ticket routed under rules that have since changed waits for David", async () => {
    const q = new LiveQueue(mapKV());
    await q.setContext([{ id: "L1", text: "Ask me everything." }], []);
    const { rev } = await q.context();
    expect(rev).toBe(1);
    const d = decisionFromAsk(ASK, "t-stale");
    const held = await q.add(d, cardFor(d.id, "settle", "A"), "Go.", 0);
    expect(reply(held)).toMatchObject({ status: "pending" });
    // Its card says so too: a quick check, not "Decided for you".
    expect(held.card).toMatchObject({ route: "check_in", settle_option: "", model_route: "settle" });
    expect(reply((await q.reroute(d.id, cardFor(d.id, "settle", "A"), "Go.", 0))!)).toMatchObject({ status: "pending" });
    expect(reply((await q.reroute(d.id, cardFor(d.id, "settle", "A"), "Go.", 1))!)).toMatchObject({ status: "settled" });
  });

  it("saving the same rules again doesn't change the revision", async () => {
    const q = new LiveQueue(mapKV());
    const { rules, facts } = await q.context();
    await q.setContext(rules, facts);
    expect((await q.context()).rev).toBe(0);
  });

  it("a reopened ticket stays David's, even if a re-route would settle it", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-sticky");
    await q.add(d, cardFor(d.id, "settle", "B"), "Wait.", 0);
    const back = await q.resolve(d.id, parseResolution({ outcome: "reopened" }, d));
    expect(back.card.route).toBe("check_in"); // every device now lists it as waiting
    const again = (await q.reroute(d.id, cardFor(d.id, "settle", "B"), "Wait.", 0))!;
    expect(reply(again)).toMatchObject({ status: "reopened" });
    expect(again.card.route).toBe("check_in");
  });

  it("set aside keeps why for every device; Resume brings it back to pending", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-resume");
    await q.add(d, cardFor(d.id, "decide"), "", 0);
    const aside = await q.resolve(d.id, parseResolution({ outcome: "set-aside", kind: "info", reason: "Need numbers.", instruction: "Get the numbers." }, d));
    expect(aside.aside).toMatchObject({ kind: "info", reason: "Need numbers.", instruction: "Get the numbers." });
    expect((await q.shown()).map((t) => t.decision.id)).toContain("t-resume");
    const back = await q.resolve(d.id, parseResolution({ outcome: "resumed" }, d));
    expect(back.aside).toBeUndefined();
    expect(reply(back)).toMatchObject({ status: "pending" });
  });

  it("every reply names its ticket, so a session can always check again", async () => {
    const q = new LiveQueue(mapKV());
    const d = decisionFromAsk(ASK, "t-handle");
    await q.add(d, cardFor(d.id, "settle", "B"), "Wait.", 0);
    expect(reply((await q.get(d.id))!).ticket).toBe("t-handle");
  });
});
