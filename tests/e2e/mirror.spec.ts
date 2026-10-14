// Hooks into Bug Me (docs/STAGE-10.md, 10d), on the stand-in server: a question a Claude Code session
// asks in the terminal is mirrored on /me, briefed, marked "Answer it in the session", and closes on an
// open page when the session's answer arrives. Events are posted as the hook script (mcp/bugme-hook.mjs)
// posts them; `npm run smoke:live` runs the script itself.
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const LIVE_KEY = process.env.BUGME_E2E_LIVE_TOKEN!;
const bearer = { authorization: `Bearer ${LIVE_KEY}` };
/** The page polls every 8 s (OWNER_POLL_MS); an arrival or a change shows within one or two polls. */
const POLLED = { timeout: 25_000 };

/** A captured AskUserQuestion (fixtures/hooks), under a fresh session so tests never share tickets. */
function capture(name: string, session: string, toolUse: string) {
  const p = JSON.parse(readFileSync(`fixtures/hooks/${name}.json`, "utf8")) as Record<string, unknown>;
  const input = p.tool_input as { questions?: unknown[] };
  const response = p.tool_response as { answers?: Record<string, string> } | undefined;
  return { session_id: session, tool_use_id: toolUse, project: "mirror-e2e", questions: input.questions, ...(response?.answers ? { answers: response.answers } : {}) };
}

async function mirror(request: APIRequestContext, body: Record<string, unknown>): Promise<string[]> {
  const r = await request.post("/api/me/mirror", { headers: bearer, data: body });
  expect(r.ok(), await r.text()).toBe(true);
  return ((await r.json()) as { tickets?: string[] }).tickets ?? [];
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`/me#k=${encodeURIComponent(LIVE_KEY)}`);
  await expect(page.locator(".live-label")).toBeVisible();
  // Set once; a reload would lose it.
  await page.evaluate(() => ((globalThis as unknown as { stayed: boolean }).stayed = true));
}
const stayed = (page: Page) => page.evaluate(() => (globalThis as unknown as { stayed?: boolean }).stayed === true);

test("a mirrored question shows, briefed late, and closes on the session's answer without a reload", async ({ page, request }, testInfo) => {
  const session = `e2e-${testInfo.project.name}-${Date.now()}`;
  const ask = await request.post("/api/me/tickets", {
    headers: bearer,
    data: { question: `Rename the export job ${session}?`, options: [{ label: "Rename it" }, { label: "Keep the name" }], context: "An ordinary ask beside the mirror.", project: "mirror-e2e" },
  });
  const ordinary = ((await ask.json()) as { ticket: string }).ticket;
  await signIn(page);

  // PreToolUse, with routing held 20 s (the stand-in is instant; a real model call takes up to a minute).
  // The hook's request is answered at once anyway.
  const t0 = Date.now();
  const [color, name, checks] = await mirror(request, { event: "pre", tool: "AskUserQuestion", ...capture("ask-pre", session, "toolu_e2e1"), test_delay_ms: 20_000 });
  expect(Date.now() - t0).toBeLessThan(5_000);

  await page.goto(`/me#/`);
  await expect(page.locator(`#mirrors li[data-id="${color}"]`)).toContainText("Answer it in the session", POLLED);
  await page.locator(`#mirrors li[data-id="${color}"] a`).click();
  const card = page.locator("#now .mirror");
  await expect(card.locator("#now-q")).toHaveText("Which color should the demo button be?");
  await expect(card.locator(".mirror-opt")).toHaveCount(4);
  await expect(card.locator(".mirror-status")).toHaveText(/Answer it in the session/);
  await expect(card).toContainText("Bug Me is still reading this one.");
  // Nothing to decide here: no option buttons, no composer, no send.
  await expect(page.locator("#now button")).toHaveCount(0);
  await expect(page.locator("#now textarea")).toHaveCount(0);

  // An answer started on an ordinary ask, in the composer, while the mirror changes in the background.
  await page.goto(`/me#/d/${ordinary}`);
  await page.locator("#think").fill("Keep the name, because two scripts use it.");

  // PostToolUse arrives before routing has finished: the answer is kept, and the late routing can't undo it.
  await mirror(request, { event: "post", tool: "AskUserQuestion", ...capture("ask-post", session, "toolu_e2e1") });
  await page.locator("#think").blur();
  await page.waitForTimeout(9_000); // a poll goes by
  await expect(page.locator("#think")).toHaveValue("Keep the name, because two scripts use it.");

  await page.goto(`/me#/d/${color}`);
  await expect(card.locator(".mirror-status")).toHaveText(/Answered in the session: Red/, POLLED);
  await expect(card.locator(".mirror-opt.picked")).toHaveText(/Red/);
  // Routing finishes after the answer: the briefing arrives, the answer stands.
  await expect(card).toContainText("Bug Me would bring it as a quick check.", POLLED);
  await expect(card.locator(".mirror-status")).toHaveText(/Answered in the session: Red/);
  await page.goto(`/me#/d/${checks}`);
  await expect(card.locator(".mirror-opt.picked")).toHaveCount(2);
  await page.goto(`/me#/d/${name}`);
  await expect(card.locator(".mirror-status")).toHaveText(/my own typed answer/);
  expect(await stayed(page)).toBe(true);

  // The session was told nothing by Bug Me, and the page can't decide it.
  expect((await request.post("/api/me/resolve", { headers: bearer, data: { id: color, outcome: "option", choice: "B" } })).status()).toBe(400);
  expect((await request.post("/api/me/converse", { headers: bearer, data: { id: color, card: { route: "decide", why_here: "" }, turns: [{ who: "jordan", text: "B" }] } })).status()).toBe(400);
  const told = (await (await request.get(`/api/me/tickets/${color}`, { headers: bearer })).json()) as Record<string, unknown>;
  expect(told).toEqual({ status: "answered", ticket: color, mirror: true, answer: { text: "Red", keys: ["A"] } });
});

test("a plan approval shows no plan, and closes when the session moves on", async ({ page, request }, testInfo) => {
  const session = `e2e-plan-${testInfo.project.name}-${Date.now()}`;
  await signIn(page);
  const [plan] = await mirror(request, { event: "pre", tool: "ExitPlanMode", session_id: session, tool_use_id: "toolu_e2e2", project: "mirror-e2e" });
  await expect(page.locator(`#mirrors li[data-id="${plan}"]`)).toBeVisible(POLLED);
  await page.goto(`/me#/d/${plan}`);
  const card = page.locator("#now .mirror");
  await expect(card.locator("#now-q")).toHaveText("Approve this session's plan?");
  await expect(card.locator(".mirror-opt")).toHaveText([/Approve/, /Keep planning/]);
  await expect(page.locator("#now button")).toHaveCount(0);
  // A rejected plan fires no PostToolUse; the session's Stop closes it.
  await mirror(request, { event: "stop", session_id: session });
  await expect(card.locator(".mirror-status")).toHaveText(/Closed: the session moved on/, POLLED);
  expect(await stayed(page)).toBe(true);
});

test("a mirror whose routing failed says so, rather than showing a route", async ({ page, request }, testInfo) => {
  const session = `e2e-unrouted-${testInfo.project.name}-${Date.now()}`;
  const [plan] = await mirror(request, { event: "pre", tool: "ExitPlanMode", session_id: session, tool_use_id: "toolu_e2e3", project: "mirror-e2e" });
  // The stand-in model never fails, so the queue is rewritten as a Worker with no key (or no budget) serves it.
  await page.route("**/api/me/queue", async (route) => {
    const res = await route.fetch();
    const q = (await res.json()) as { mirrors: Record<string, Record<string, unknown>> };
    if (q.mirrors[plan]) {
      delete q.mirrors[plan].shadow;
      q.mirrors[plan] = { ...q.mirrors[plan], routed: true, unrouted: "today's budget is spent" };
    }
    await route.fulfill({ response: res, json: q });
  });
  await signIn(page);
  await page.goto(`/me#/d/${plan}`);
  const card = page.locator("#now .mirror");
  await expect(card.locator(".why")).toHaveText("Bug Me couldn't route this one (today's budget is spent).");
  await expect(page.locator(`#now`)).not.toContainText("would bring it");
});
