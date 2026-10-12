// The owner's live queue in the browser (docs/STAGE-7.md), on the stand-in server with a throwaway
// owner key. A session's ask shows up on /me, the owner answers it in the same thread as the
// simulation, and the answer reaches the asking session at the moment of the press; if it can't,
// the card says so and stays open for another press.
import { type APIRequestContext, expect, test } from "@playwright/test";
import { OWNER_RULES } from "../../src/worker/live";
import { decide, decideQuietly, hold, toDecision } from "./helpers";

const LIVE_KEY = process.env.BUGME_E2E_LIVE_TOKEN!;
const bearer = { authorization: `Bearer ${LIVE_KEY}` };

async function ask(request: APIRequestContext, question: string): Promise<string> {
  const r = await request.post("/api/me/tickets", {
    headers: bearer,
    data: {
      question,
      options: [
        { label: "Ship it now", reversible: "partly", cost_usd: 0 },
        { label: "Hold for review", reversible: "yes", cost_usd: 0 },
      ],
      context: "An e2e ask from a pretend session.",
      project: "e2e",
      session: "live spec",
    },
  });
  expect(r.ok(), await r.text()).toBe(true);
  const t = (await r.json()) as { status: string; ticket: string };
  expect(t.status).toBe("pending");
  return t.ticket;
}

async function told(request: APIRequestContext, id: string): Promise<Record<string, string>> {
  return (await (await request.get(`/api/me/tickets/${id}`, { headers: bearer })).json()) as Record<string, string>;
}

test("without the link, the owner's queue is closed", async ({ request }) => {
  expect((await request.get("/api/me/queue")).status()).toBe(401);
  expect((await request.post("/api/me/login", { data: { k: "wrong" } })).status()).toBe(403);
});

test("an ask appears on /me, and the owner's answer and reason reach the session when pressed", async ({ page, request }) => {
  const id = await ask(request, `Publish the release notes for build ${Date.now()}?`);
  await page.goto(`/me#k=${encodeURIComponent(LIVE_KEY)}`);
  await expect(page.locator(".live-label")).toHaveText("Live · your real queue");
  await expect(page).toHaveURL(/\/me#\/$/); // the key left the address bar
  await expect(page.locator(".tours-btn")).toHaveCount(0);
  await page.goto(`/me#/d/${id}`);
  await expect(page.locator("#now")).toContainText("Publish the release notes");
  await decide(page, "Hold for review", "Hold for review, because nobody has read them yet.");
  await expect.poll(async () => (await told(request, id)).status, { timeout: 15_000 }).toBe("answered");
  expect(await told(request, id)).toMatchObject({ choice: "B", label: "Hold for review" });
  expect((await told(request, id)).reason).toContain("nobody has read them yet");
});

test("if the session can't be reached, nothing is recorded and the card stays open for another press", async ({ page, request }) => {
  const id = await ask(request, `Archive the old dashboards ${Date.now()}?`);
  await page.goto(`/me#k=${encodeURIComponent(LIVE_KEY)}`);
  await page.goto(`/me#/d/${id}`);
  let fail = true;
  await page.route("**/api/me/resolve", (route) => (fail ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "offline" }) }) : route.continue()));
  await decide(page, "Hold for review", "Hold for review, because the team still uses two of them.");
  await expect(page.locator("#now")).toContainText("Couldn't reach the asking session");
  expect((await told(request, id)).status).toBe("pending");
  await expect(page.locator("#now")).not.toContainText("hidden until now"); // the guess stays sealed until it's sent
  fail = false;
  await toDecision(page); // press the decision again
  await expect.poll(async () => (await told(request, id)).status, { timeout: 15_000 }).toBe("answered");
});

test("a page opened before a rule edit elsewhere can't overwrite it by talking", async ({ page, request }, testInfo) => {
  // It edits the one owner queue's rules: run in one project, so another project's cleanup can't race it.
  test.skip(testInfo.project.name !== "desktop", "edits the shared owner queue's rules");
  const id = await ask(request, `Rename the staging bucket ${Date.now()}?`);
  await page.goto(`/me#k=${encodeURIComponent(LIVE_KEY)}`);
  await page.goto(`/me#/d/${id}`);
  await expect(page.locator("#now")).toContainText("Rename the staging bucket");
  // Another device edits the rules after this page loaded.
  const q = (await (await request.get("/api/me/queue", { headers: bearer })).json()) as { rules: { id: string; text: string }[]; facts: unknown[] };
  const edited = q.rules.map((r) => (r.id === "L10" ? { ...r, text: `Small changes: ask me first (${id}).` } : r));
  expect((await request.post("/api/me/context", { headers: bearer, data: { rules: edited, facts: q.facts } })).ok()).toBe(true);
  // This page, still holding the old rules, carries on the conversation.
  await page.locator("#think").fill("Hold for review, because the team uses that name in scripts.");
  await page.locator("#now .send").click();
  await expect(page.locator("#now .turns li.typing")).toHaveCount(0, { timeout: 15_000 });
  const after = (await (await request.get("/api/me/queue", { headers: bearer })).json()) as { rules: { id: string; text: string }[] };
  expect(after.rules.find((r) => r.id === "L10")!.text).toBe(`Small changes: ask me first (${id}).`);
  // Leave the queue's rules as they were, for the next run.
  await request.post("/api/me/context", { headers: bearer, data: { rules: OWNER_RULES, facts: q.facts } });
});

async function open(page: import("@playwright/test").Page, id: string): Promise<void> {
  await page.goto(`/me#k=${encodeURIComponent(LIVE_KEY)}`);
  await page.goto(`/me#/d/${id}`);
  await expect(page.locator("#now #now-q")).toBeVisible();
}

/** Answer against the agent's pick with a reason, so Bug Me offers to remember it. */
async function toProposal(page: import("@playwright/test").Page): Promise<void> {
  await decide(page, "Hold for review", "Hold for review, because the team still needs a look at it.");
  await expect(page.getByRole("button", { name: "Keep it" })).toBeVisible({ timeout: 15_000 });
}

/** Fail the guidance update (only) until told otherwise. */
async function failGuidance(page: import("@playwright/test").Page): Promise<{ stop: () => void }> {
  let failing = true;
  await page.route("**/api/me/resolve", (route) =>
    failing && (route.request().postDataJSON() ?? {}).guidance
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "offline" }) })
      : route.continue(),
  );
  return { stop: () => (failing = false) };
}

/** Resets of the one owner queue, by project, in this worker (the tests below check who resets it). */
const resets: Record<string, number> = {};

async function resetOwner(request: APIRequestContext, project: string): Promise<void> {
  resets[project] = (resets[project] ?? 0) + 1;
  await request.post("/api/me/context", { headers: bearer, data: { rules: OWNER_RULES, facts: [] } });
}

// Guidance tests change the one owner queue's facts: desktop only, run in order, cleaned up after.
test.describe("kept guidance on /me", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "changes the shared owner queue's facts");
    await resetOwner(request, testInfo.project.name);
  });
  // Playwright runs afterEach even for a test its beforeEach skipped: check the project here too.
  test.afterEach(async ({ request }, testInfo) => {
    if (testInfo.project.name === "desktop") await resetOwner(request, testInfo.project.name);
  });

  test("a retry after a failed answer update also re-checks the decisions the guidance affects", async ({ page, request }) => {
    const id = await ask(request, `Rename the billing exports ${Date.now()}?`);
    const other = await ask(request, `Rename the invoice files ${Date.now()}?`);
    // The stand-in suggests nothing to re-check for a live ask (no tags), so the proposal names the other ticket.
    await page.route("**/api/me/fact", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...body, reroute: [other] } });
    });
    const routed: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/me/route")) routed.push(String((r.postDataJSON() ?? {}).id));
    });
    await open(page, id);
    await toProposal(page);
    const g = await failGuidance(page);
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(page.locator("#now")).toContainText("The guidance is saved, but couldn't be added");
    g.stop();
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(page.locator("#now")).toContainText("Kept for future asks");
    await expect.poll(() => routed, { timeout: 15_000 }).toContain(other);
    expect((await told(request, id)).guidance).toBeTruthy();
  });

  test("guidance kept on an older page can't reverse an answer changed since on another device", async ({ page, request }) => {
    const id = await ask(request, `Retire the old status page ${Date.now()}?`);
    await open(page, id);
    await toProposal(page); // this page answered "Hold for review" (B)
    // Another device changes the answer to "Ship it now" (A).
    expect((await request.post("/api/me/resolve", { headers: bearer, data: { id, outcome: "option", choice: "A" } })).ok()).toBe(true);
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(page.locator("#now")).toContainText("changed");
    const now = await told(request, id);
    expect(now.choice).toBe("A");
    expect(now.guidance).toBeUndefined();
  });

  test("with 30 facts, retrying the 30th's answer update updates rather than hitting the cap", async ({ page, request }) => {
    const seed = Array.from({ length: 29 }, (_, i) => ({ id: `S${i + 1}`, text: `Seed fact ${i + 1}.`, source: "e2e", scope: "all" }));
    expect((await request.post("/api/me/context", { headers: bearer, data: { rules: OWNER_RULES, facts: seed } })).ok()).toBe(true);
    const id = await ask(request, `Move the nightly job to 2am ${Date.now()}?`);
    await open(page, id);
    await toProposal(page);
    const g = await failGuidance(page);
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(page.locator("#now")).toContainText("The guidance is saved, but couldn't be added");
    g.stop();
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(page.locator("#now")).toContainText("Kept for future asks");
    expect((await told(request, id)).guidance).toBeTruthy();
  });
});

test("the guidance tests' cleanup runs only where they run (desktop), never under another project's tests", async ({}, testInfo) => {
  for (const [project, n] of Object.entries(resets)) if (project !== "desktop") expect(n, `${project} reset the shared queue`).toBe(0);
  expect(testInfo.project.name).toBeTruthy();
});

test("a double-pressed Undo on /me reopens once", async ({ page, request }) => {
  // A free, reversible staging deploy is settled by the staging rule (on the stand-in too).
  const r = await request.post("/api/me/tickets", {
    headers: bearer,
    data: {
      question: `Deploy the docs site to staging from main (${Date.now()})?`,
      options: [
        { label: "Deploy to staging", reversible: "yes", cost_usd: 0 },
        { label: "Wait", reversible: "yes", cost_usd: 0 },
      ],
      recommended: "Deploy to staging",
      context: "main is green.",
      project: "e2e",
    },
  });
  const t = (await r.json()) as { status: string; ticket: string };
  expect(t.status).toBe("settled");
  const reopens: unknown[] = [];
  page.on("request", (q) => {
    if (q.url().endsWith("/api/me/resolve") && (q.postDataJSON() ?? {}).outcome === "reopened") reopens.push(q.postDataJSON());
  });
  await page.goto(`/me#k=${encodeURIComponent(LIVE_KEY)}`);
  await page.goto("/me#/settled");
  const release = await hold(page, "/api/me/resolve");
  await page.locator("#settled .dgroup:not([open]) > summary").first().click().catch(() => {});
  const row = page.locator(`#settled .drow[data-id="${t.ticket}"]`);
  await row.locator(".dundo").click();
  await row.locator(".dundo").click();
  release();
  await expect.poll(async () => (await told(request, t.ticket)).status, { timeout: 15_000 }).toBe("reopened");
  await page.waitForTimeout(500);
  expect(reopens).toHaveLength(1);
});

test("setting aside on /me doesn't pull you back if you've moved on while the session was told", async ({ page, request }) => {
  const id = await ask(request, `Turn off the legacy endpoint ${Date.now()}?`);
  await open(page, id);
  const release = await hold(page, "/api/me/resolve");
  await page.locator("#now .skip-q").click();
  await page.getByRole("button", { name: "I need more information" }).click();
  await page.locator("#punt-reason").fill("How many customers still call it?");
  await page.getByRole("button", { name: "Set aside" }).click();
  await page.evaluate("location.hash = '#/rules'");
  await expect(page).toHaveURL(/#\/rules$/);
  release();
  await expect.poll(async () => (await told(request, id)).status, { timeout: 15_000 }).toBe("set-aside");
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#\/rules$/);
});

test("asking the agent on /me doesn't pull you back if you've moved on", async ({ page, request }) => {
  const id = await ask(request, `Drop the beta flag ${Date.now()}?`);
  await open(page, id);
  const question = "Who still has it on?";
  const ledger = { choice: "none", choice_quote: null, course: null, action: "", why: [], conditions: [], questions: [{ quote: { turn: 0, quote: question }, answer: null }], feedback: [], no_more_questions: false };
  await page.route("**/api/me/converse", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: `I'll ask the agent: ${question}`, next: "confirm", ledger, heard: "x", source: "code" }) }),
  );
  await page.locator("#think").fill(question);
  await page.locator("#now .send").click();
  await expect(page.locator("#now .send.decide")).toBeVisible({ timeout: 15_000 });
  const release = await hold(page, "/api/me/resolve");
  await page.locator("#now .send.decide").click();
  await page.evaluate("location.hash = '#/rules'");
  await expect(page).toHaveURL(/#\/rules$/);
  release();
  await expect.poll(async () => (await told(request, id)).status, { timeout: 15_000 }).toBe("set-aside");
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#\/rules$/);
});

test("Skip during a late reason's delivery wins: the reason is sent, but no guidance is proposed", async ({ page, request }) => {
  const id = await ask(request, `Archive the 2024 reports ${Date.now()}?`);
  await open(page, id);
  await decideQuietly(page, "Hold for review"); // no reason, against the guess: Bug Me asks why
  await expect(page.locator("#why")).toBeVisible({ timeout: 15_000 });
  const facts: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/me/fact")) facts.push(r.url());
  });
  const release = await hold(page, "/api/me/resolve", (b) => typeof b.reason === "string" && !b.instruction);
  await page.locator("#why").fill("Finance still reads them every quarter.");
  await page.getByRole("button", { name: "Tell Bug Me" }).click();
  await page.locator("#now .followup").getByRole("button", { name: "Skip", exact: true }).click();
  release();
  await expect.poll(async () => (await told(request, id)).reason, { timeout: 15_000 }).toBe("Finance still reads them every quarter.");
  await page.waitForTimeout(1000);
  expect(facts).toEqual([]);
  await expect(page.locator("#now")).not.toContainText("Remember this");
});

test("the simulation is untouched: no live label, tours still there", async ({ page }) => {
  await page.goto("/app#/");
  await expect(page.locator(".synthetic")).toContainText("Synthetic");
  await expect(page.locator(".tours-btn")).toHaveCount(1);
});
