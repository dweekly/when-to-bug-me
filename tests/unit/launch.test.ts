// Stage 9 (docs/STAGE-9.md): the brief's saved ticks and the runner's launch record.
import { describe, expect, it } from "vitest";
import { type Catalog, DispatchError, allTicked, finishBrief, parseBriefDraft, parseCatalog, parseEdits, parseLaunch, toolPrefix } from "../../src/shared/dispatch";
import { fakeDispatch } from "../../src/shared/fakeDispatch";
import { LiveQueue, mapKV } from "../../src/worker/live";

const server = (name: string, status = "connected") => ({ name, prefix: toolPrefix(name), status });
const CAT: Catalog = parseCatalog({ servers: [server("bugme"), server("PagerDuty", "needs authentication")], skills: [] });

async function stored() {
  const q = new LiveQueue(mapKV());
  const d = parseBriefDraft(fakeDispatch("Hook the release bot up to PagerDuty", "", CAT), CAT, [], []);
  const b = finishBrief(d, CAT, { id: "b-abcdefghij", task: "t", now: new Date(), owner: true });
  await q.addBrief(b);
  return { q, b };
}
const edits = (b: { model: string; effort: string; permission_mode: string }, extra: Record<string, unknown> = {}) => ({
  model: b.model,
  effort: b.effort,
  permission_mode: b.permission_mode,
  estimate_minutes: 30,
  budget_usd: 2,
  tools_off: [],
  ...extra,
});

describe("ticks are saved on the brief", () => {
  it("keeps the ticked items, and drops any past the brief's list", async () => {
    const { q, b } = await stored();
    expect(b.prerequisites.length).toBeGreaterThan(0);
    const next = await q.dispatched(b.id, parseEdits(edits(b, { ticked: [0, 0, 7] }), CAT));
    expect(next!.ticked).toEqual(b.prerequisites.length > 7 ? [0, 7] : [0]);
  });

  it("refuses ticks that aren't item numbers", () => {
    for (const ticked of [[-1], [1.5], ["0"], Array.from({ length: 200 }, (_, i) => i), "0"]) {
      expect(() => parseEdits(edits({ model: "claude-opus-5-5", effort: "medium", permission_mode: "plan" }, { ticked }), CAT)).toThrow(DispatchError);
    }
  });

  it("allTicked needs every item", () => {
    expect(allTicked({ prerequisites: [], ticked: undefined })).toBe(true);
    expect(allTicked({ prerequisites: [{ what: "a", why: "" }, { what: "b", why: "" }], ticked: [1] })).toBe(false);
    expect(allTicked({ prerequisites: [{ what: "a", why: "" }, { what: "b", why: "" }], ticked: [0, 1] })).toBe(true);
  });
});

describe("one launch per brief", () => {
  it("a second reservation gets the first one back", async () => {
    const { q, b } = await stored();
    const first = await q.launch(b.id, parseLaunch({ state: "launching", repo: "sandbox" }));
    expect(first!.ok).toBe(true);
    const second = await q.launch(b.id, parseLaunch({ state: "launching", repo: "other" }));
    expect(second!.ok).toBe(false);
    expect(second!.brief.launch).toMatchObject({ state: "launching", repo: "sandbox" });
  });

  it("running keeps the reservation's clock; a failed launch can be tried again", async () => {
    const { q, b } = await stored();
    const r = await q.launch(b.id, parseLaunch({ state: "launching", repo: "sandbox" }, new Date("2026-10-14T10:00:00Z")));
    const run = await q.launch(b.id, parseLaunch({ state: "running", repo: "sandbox", session_id: "4e653586" }, new Date("2026-10-14T10:05:00Z")));
    expect(run!.brief.launch).toMatchObject({ state: "running", session_id: "4e653586", at: r!.brief.launch!.at });
    expect((await q.launch(b.id, parseLaunch({ state: "launching", repo: "sandbox" })))!.ok).toBe(false);
    await q.launch(b.id, parseLaunch({ state: "failed", repo: "sandbox", error: "the session didn't start" }));
    expect((await q.launch(b.id, parseLaunch({ state: "launching", repo: "sandbox" })))!.ok).toBe(true);
  });

  it("running or failed without a reservation, or for another repo, is refused", async () => {
    const { q, b } = await stored();
    expect((await q.launch(b.id, parseLaunch({ state: "running", repo: "sandbox" })))!.ok).toBe(false);
    await q.launch(b.id, parseLaunch({ state: "launching", repo: "sandbox" }));
    expect((await q.launch(b.id, parseLaunch({ state: "running", repo: "other" })))!.ok).toBe(false);
  });

  it("the record comes in clean", () => {
    for (const bad of [{ state: "done", repo: "x" }, { state: "launching", repo: "../etc" }, { state: "launching", repo: "a/b" }, { state: "running", repo: "x", session_id: "$(id)" }]) {
      expect(() => parseLaunch(bad)).toThrow(DispatchError);
    }
  });
});
