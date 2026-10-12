// The owner's live queue in the browser (docs/STAGE-7.md), on the stand-in server with a throwaway
// owner key. A session's ask shows up on /me, the owner answers it in the same thread as the
// simulation, and the answer reaches the asking session at the moment of the press; if it can't,
// the card says so and stays open for another press.
import { type APIRequestContext, expect, test } from "@playwright/test";
import { OWNER_RULES } from "../../src/worker/live";
import { decide, toDecision } from "./helpers";

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

test("a page opened before a rule edit elsewhere can't overwrite it by talking", async ({ page, request }) => {
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
  // Not reverted to the page's old copy (desktop and phone run this at once against one queue, so either edit may be the latest).
  expect(after.rules.find((r) => r.id === "L10")!.text).toMatch(/^Small changes: ask me first \(t-/);
  // Leave the queue's rules as they were, for the next run.
  await request.post("/api/me/context", { headers: bearer, data: { rules: OWNER_RULES, facts: q.facts } });
});

test("the simulation is untouched: no live label, tours still there", async ({ page }) => {
  await page.goto("/app#/");
  await expect(page.locator(".synthetic")).toContainText("Synthetic");
  await expect(page.locator(".tours-btn")).toHaveCount(1);
});
