// The owner's live queue in the browser (docs/STAGE-7.md), on the stand-in server with a throwaway
// owner key. A session's ask shows up on /me, the owner answers it with the same card as the
// simulation, and the answer, with the reason, is what the asking session is told.
import { type APIRequestContext, expect, test } from "@playwright/test";
import { decide } from "./helpers";

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

test("without the link, the owner's queue is closed", async ({ request }) => {
  expect((await request.get("/api/me/queue")).status()).toBe(401);
  expect((await request.post("/api/me/login", { data: { k: "wrong" } })).status()).toBe(403);
});

test("an ask appears on /me, and the owner's answer and reason go back to the session", async ({ page, request }) => {
  const question = `Publish the release notes for build ${Date.now()}?`;
  const id = await ask(request, question);
  await page.goto(`/me#k=${encodeURIComponent(LIVE_KEY)}`);
  await expect(page.locator(".live-label")).toHaveText("Live · your real queue");
  await expect(page).toHaveURL(/\/me#\/$/); // the token left the address bar
  await expect(page.locator(".tours-btn")).toHaveCount(0);
  await page.goto(`/me#/d/${id}`);
  await expect(page.locator("#now")).toContainText("Publish the release notes");
  // The live page keeps its own saved state, so the simulation's think() helper can't watch it; Send waits for the reading anyway.
  await page.locator("#think").fill("Hold for review, because nobody has read them yet.");
  await decide(page, "Hold for review");
  await expect
    .poll(async () => ((await (await request.get(`/api/me/tickets/${id}`, { headers: bearer })).json()) as { status: string }).status, { timeout: 15_000 })
    .toBe("answered");
  const told = (await (await request.get(`/api/me/tickets/${id}`, { headers: bearer })).json()) as Record<string, string>;
  expect(told).toMatchObject({ choice: "B", label: "Hold for review" });
  expect(told.instruction).toBeTruthy();
  expect(told.reason).toContain("nobody has read them yet");
});

test("the simulation is untouched: no live label, tours still there", async ({ page }) => {
  await page.goto("/app#/");
  await expect(page.locator(".synthetic")).toContainText("Synthetic");
  await expect(page.locator(".tours-btn")).toHaveCount(1);
});
