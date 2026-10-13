// Stage 6e's "Huh?" (docs/STAGE-6E.md): one press asks Bug Me to say the last thing it showed more
// plainly. On the fake-model server the stand-in answers a press, or "I don't follow", with code's own
// restatement ("In plain terms: …").
import { type Page, expect, test } from "@playwright/test";
import { freshPage, hold, openDecision, option, reply, say, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

const turns = (page: Page) => page.locator("#now .turns > li");
const sendBtn = (page: Page) => page.locator("#now .send");
// One Huh? button, just above the box (docs/STAGE-6F.md).
const huh = (page: Page) => page.locator("#now .huh-row .huh");
const record = async (page: Page) => ((await stored(page))?.record ?? []) as Record<string, unknown>[];

test("Huh? sends at once and keeps unsent words; it stays just above the box, never on a turn", async ({ page }) => {
  await openDecision(page, "reconciliation-path");
  await expect(huh(page)).toBeVisible();
  await page.locator("#think").fill("Half a thought");
  await huh(page).click();
  await reply(page);
  await expect(turns(page)).toHaveCount(2);
  await expect(turns(page).nth(0)).toHaveClass(/huh-turn/);
  await expect(turns(page).nth(0)).toContainText("Huh?");
  await expect(turns(page).nth(1)).toHaveClass(/explain/);
  await expect(turns(page).nth(1)).toContainText("In plain terms:");
  await expect(turns(page).nth(1)).toContainText("1.5% of invoices");
  await expect(page.locator("#think")).toHaveValue("Half a thought");
  // An explanation is not a read-back: the button still sends.
  await expect(sendBtn(page)).toHaveText("Send");
  await expect(huh(page)).toBeVisible();
  await expect(page.locator("#now .turns .huh, #now-q ~ .huh")).toHaveCount(0);
  const below = (a: string, b: string) => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(a)}).compareDocumentPosition(document.querySelector(${JSON.stringify(b)})) & Node.DOCUMENT_POSITION_FOLLOWING)`);
  expect(await below("#now .options", "#now .huh-row")).toBe(true);
  expect(await below("#now .turns", "#now .huh-row")).toBe(true);
  expect(await below("#now .huh-row", "#now .composer")).toBe(true);
});

test("two presses per conversation; after that, talking and deciding still work", async ({ page }) => {
  await openDecision(page, "reconciliation-path");
  await huh(page).click();
  await reply(page);
  await huh(page).click();
  await reply(page);
  await expect(turns(page)).toHaveCount(4);
  await expect(huh(page)).toBeHidden();
  await option(page, "Keep T-19 mapping").click();
  await say(page, "Because corrected invoices would confuse customers.");
  await expect(turns(page).last()).toHaveClass(/readback/);
  await expect(huh(page)).toBeHidden();
  await sendBtn(page).click();
  await expect.poll(async () => (await record(page)).find((e) => e.kind === "answer" && e.id === "reconciliation-path")?.unclear).toBe(2);
});

test("Huh? is off while a turn is out, and a double press sends one turn", async ({ page }) => {
  const calls: unknown[] = [];
  page.on("request", (r) => r.url().includes("/api/converse") && calls.push(r.postDataJSON()));
  await openDecision(page, "reconciliation-path");
  const release = await hold(page, "/api/converse");
  await huh(page).dblclick();
  await expect(page.locator("#now .turns li.typing")).toHaveCount(1);
  await expect(huh(page)).toBeHidden();
  release();
  await reply(page);
  expect(calls).toHaveLength(1);
  await expect(turns(page)).toHaveCount(2);
});

test("Huh? on the read-back keeps what Bug Me heard and leaves the decision one press away", async ({ page }) => {
  await openDecision(page, "api-rename");
  await say(page, "Keep user_id, because integrators parse v1 responses.");
  await expect(turns(page).last()).toHaveClass(/readback/);
  await expect(sendBtn(page)).toHaveText("Keep user_id");
  await huh(page).click();
  await reply(page);
  await expect(turns(page).last()).toHaveClass(/explain/);
  await expect(sendBtn(page)).toHaveText("Keep user_id");
  await expect(page.locator('#now .opt[aria-pressed="true"]')).toHaveCount(1);
  await expect(turns(page).nth(0).locator("mark.m-why")).toHaveCount(1);
  // A typed yes after the explanation answers the read-back it explained.
  await say(page, "yes");
  await expect(turns(page).last()).toContainText("Got it");
  await sendBtn(page).click();
  await expect.poll(async () => ((await stored(page))?.answered?.["api-rename"] as { final?: string } | undefined)?.final).toBe("B");
});

test("typed confusion gets the same plain restatement, and is marked as feedback", async ({ page }) => {
  await openDecision(page, "reconciliation-path");
  await say(page, "I don't follow.");
  await expect(turns(page).last()).toHaveClass(/explain/);
  await expect(turns(page).nth(0).locator("mark.m-fb")).toHaveText("I don't follow.");
});

test("a press that fails offers Send again, which asks the same thing again and leaves the draft alone", async ({ page }) => {
  await openDecision(page, "reconciliation-path");
  await page.locator("#think").fill("A draft I'm keeping");
  await page.route("**/api/converse", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "down for a moment" }) }));
  await huh(page).click();
  await expect(page.locator("#now .think-msg")).toContainText("Bug Me couldn't reply just now");
  await expect(huh(page)).toBeHidden();
  await page.unroute("**/api/converse");
  await expect(sendBtn(page)).toHaveText("Send again");
  await sendBtn(page).click();
  await reply(page);
  await expect(turns(page)).toHaveCount(2);
  await expect(turns(page).first()).toHaveClass(/huh-turn/);
  await expect(turns(page).last()).toHaveClass(/explain/);
  await expect(page.locator("#think")).toHaveValue("A draft I'm keeping");
});

test("at 320px: Huh? and a long explanation fit without sideways scroll @narrow", async ({ page }) => {
  const wide = () => page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as Promise<number>;
  await openDecision(page, "reconciliation-path");
  expect(await wide()).toBeLessThanOrEqual(0);
  await huh(page).click();
  await reply(page);
  await expect(huh(page)).toBeVisible();
  expect(await wide()).toBeLessThanOrEqual(0);
});
