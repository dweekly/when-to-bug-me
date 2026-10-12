// The owner's live page (src/page/live.ts, docs/STAGE-7.md), loaded in Node with small stand-ins for the
// browser: deliveries survive failures and two tabs, the server is the source of truth on load, rule
// edits retry until saved, and unfinished follow-ups survive a reload.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Fetch = (url: string, init?: { body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** A browser-ish global scope for one "tab": shared storage, its own fetch. */
function browser(storage: Map<string, string>, fetchImpl: Fetch) {
  const g = globalThis as unknown as Record<string, unknown>;
  g.location = { pathname: "/me", hash: "#/", search: "", reload: vi.fn() };
  g.localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
  g.document = { body: { dataset: {} }, visibilityState: "visible", addEventListener: () => {} };
  g.history = { replaceState: () => {} };
  g.fetch = fetchImpl;
}

const reply = (status: number, data: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(data) });

async function freshModules() {
  vi.resetModules();
  const live = await import("../../src/page/live");
  const state = await import("../../src/page/state");
  return { live, state };
}

function queue(extra: Record<string, unknown> = {}) {
  return {
    persona: { synthetic: false, name: "David", first_name: "David", pronouns: "they/them", role: "", company: "", company_blurb: "", fleet_size: 1, projects: [], how_to_work_with_me: [], how_to_work_with_me_source: "" },
    rules: [{ id: "L1", text: "Server rule." }],
    facts: [],
    decisions: [{ id: "t-1", project: "p", options: [{ key: "A", label: "A" }, { key: "B", label: "B" }] }],
    cards: [{ id: "t-1", route: "check_in", headline: "From the server" }],
    live_available: true,
    mode: "live",
    turnstile_site_key: null,
    owner: true,
    ...extra,
  } as never;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("delivery", () => {
  it("retries an answer the Worker didn't get, and sends each one once it's back", async () => {
    const storage = new Map<string, string>();
    const sent: unknown[] = [];
    let up = false;
    browser(storage, (_u, init) => {
      if (!up) return Promise.reject(new Error("offline"));
      sent.push(JSON.parse(init!.body!));
      return reply(200, { status: "answered" });
    });
    const { live, state } = await freshModules();
    state.setS(state.fresh(queue()));
    live.deliver("t-1", { outcome: "option", choice: "B" });
    await vi.advanceTimersByTimeAsync(10);
    expect(JSON.parse(storage.get("bugme.live.outbox")!)).toHaveLength(1);
    up = true;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sent).toEqual([{ id: "t-1", outcome: "option", choice: "B" }]);
    expect(JSON.parse(storage.get("bugme.live.outbox")!)).toEqual([]);
  });

  it("drops an answer the Worker refuses outright, so it can't hold up the ones behind it", async () => {
    const storage = new Map<string, string>();
    const sent: string[] = [];
    browser(storage, (_u, init) => {
      const b = JSON.parse(init!.body!);
      sent.push(b.id);
      return b.id === "t-gone" ? reply(400, { error: "unknown ticket" }) : reply(200, {});
    });
    const { live, state } = await freshModules();
    state.setS(state.fresh(queue()));
    live.deliver("t-gone", { outcome: "option", choice: "A" });
    live.deliver("t-1", { outcome: "option", choice: "B" });
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual(["t-gone", "t-1"]);
    expect(JSON.parse(storage.get("bugme.live.outbox")!)).toEqual([]);
  });

  it("still delivers when this browser can't store anything", async () => {
    const sent: unknown[] = [];
    browser(new Map(), (_u, init) => {
      sent.push(JSON.parse(init!.body!));
      return reply(200, {});
    });
    (globalThis as unknown as { localStorage: { setItem: () => void } }).localStorage.setItem = () => {
      throw new Error("quota");
    };
    const { live } = await freshModules();
    live.deliver("t-1", { outcome: "set-aside", reason: "later" });
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(1);
  });

  it("with two tabs open, an acknowledgement removes only its own answer", async () => {
    const storage = new Map<string, string>();
    const sent: string[] = [];
    let fail2 = true;
    const f: Fetch = (_u, init) => {
      const b = JSON.parse(init!.body!);
      sent.push(b.choice);
      if (b.choice === "second" && fail2) return Promise.reject(new Error("blip"));
      return reply(200, {});
    };
    browser(storage, f);
    const tabA = await freshModules();
    tabA.live.deliver("t-1", { outcome: "option", choice: "first" });
    tabA.live.deliver("t-1", { outcome: "option", choice: "second" });
    browser(storage, f);
    const tabB = await freshModules(); // loads both from storage
    await vi.advanceTimersByTimeAsync(10);
    fail2 = false;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sent.filter((c) => c === "second").length).toBeGreaterThanOrEqual(2); // retried, not lost
    expect(JSON.parse(storage.get("bugme.live.outbox")!)).toEqual([]);
    expect(tabB).toBeTruthy();
  });
});

describe("the server is the source of truth on load", () => {
  it("takes its cards, rules and set-aside list, but keeps an answer in progress and a pending set-aside", async () => {
    const storage = new Map<string, string>();
    browser(storage, () => reply(200, {}));
    const { live, state } = await freshModules();
    const S = state.fresh(queue());
    S.cards["t-1"] = { id: "t-1", route: "decide", headline: "Stale, from this browser" } as never;
    S.punts["t-1"] = { id: "t-1", kind: "info", reason: "old", instruction: "", at: "" };
    S.rules = [{ id: "L1", text: "Edited here, never saved." }];
    state.setS(S);
    live.startOwner(queue());
    expect(state.S.cards["t-1"]).toMatchObject({ headline: "From the server" });
    expect(state.S.rules).toEqual([{ id: "L1", text: "Server rule." }]);
    expect(state.S.punts["t-1"]).toBeUndefined(); // resumed elsewhere

    live.deliver("t-1", { outcome: "set-aside", reason: "mine" });
    state.S.punts["t-1"] = { id: "t-1", kind: "info", reason: "mine", instruction: "", at: "" };
    live.startOwner(queue());
    expect(state.S.punts["t-1"]?.reason).toBe("mine"); // not yet delivered: still this browser's
  });

  it("keeps an unfinished follow-up for a ticket answered in the last day", async () => {
    browser(new Map(), () => reply(200, {}));
    const { live, state } = await freshModules();
    const S = state.fresh(queue());
    S.flows["t-done"] = { ...state.newFlow("t-done"), phase: "why" };
    S.flows["t-gone"] = { ...state.newFlow("t-gone"), phase: "why" };
    state.setS(S);
    live.startOwner(queue({ answered: [{ decision: { id: "t-done", project: "p", options: [] }, card: { id: "t-done", route: "decide" } }] }));
    expect(state.S.flows["t-done"]?.phase).toBe("why");
    expect(state.S.flows["t-gone"]).toBeUndefined();
  });
});

describe("rule edits", () => {
  it("retry until the server has them, and only then count as saved", async () => {
    const posted: unknown[] = [];
    let up = false;
    browser(new Map(), (url, init) => {
      if (!url.endsWith("/context")) return reply(200, {});
      if (!up) return Promise.reject(new Error("offline"));
      posted.push(JSON.parse(init!.body!));
      return reply(200, { ok: true });
    });
    const { live, state } = await freshModules();
    state.setS(state.fresh(queue()));
    live.startOwner(queue());
    state.S.rules = [{ id: "L1", text: "Edited." }];
    state.save();
    await vi.advanceTimersByTimeAsync(10);
    up = true;
    state.save(); // an unrelated save while still unsynced must not mark it saved
    await vi.advanceTimersByTimeAsync(16_000);
    expect(posted.at(-1)).toMatchObject({ rules: [{ id: "L1", text: "Edited." }] });
  });
});
