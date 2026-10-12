// Stage 4's decision card (docs/STAGE-4.md): the options side by side, one place to think out loud,
// Bug Me's marks on the person's own words, clicking picks and Send decides. On the fake-model
// server, whose stand-in parser reads full option labels, "because…" reasons, "but…/as long as…"
// conditions, "?" questions, and "Instead, …" for something else.
import { type Page, expect, test } from "@playwright/test";
import { decide, freshPage, goHome, hold, openDecision, option, stored, think } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

const answered = async (page: Page, id: string) => (await stored(page))?.answered?.[id] as Record<string, unknown> | undefined;

test("the briefing comes before the question; the options sit side by side; Send waits for a pick", async ({ page }) => {
  await openDecision(page, "api-rename");
  const order = await page.evaluate(
    "Boolean(document.querySelector('#now .briefing').compareDocumentPosition(document.querySelector('#now-q')) & Node.DOCUMENT_POSITION_FOLLOWING)",
  );
  expect(order).toBe(true);
  const [a, b] = await page.locator("#now .opt").all();
  const [ba, bb] = [await a.boundingBox(), await b.boundingBox()];
  if ((page.viewportSize()?.width ?? 0) > 700) expect(Math.abs(ba!.y - bb!.y)).toBeLessThan(2); // same row on desktop
  await expect(page.locator("#now .opt .snippet").first()).toContainText('"account_id"');
  await expect(page.locator("#now .send")).toBeDisabled();
  for (const gone of ["Yes, but…", "Something else", "Ask a question", "Decide"]) await expect(page.locator("#now").getByRole("button", { name: gone, exact: true })).toHaveCount(0);
});

test("clicking an option picks it and sends nothing; Send records the answer", async ({ page }) => {
  const answers: string[] = [];
  page.on("request", (r) => r.url().includes("/api/answer") && answers.push(r.url()));
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await expect(option(page, "File all five as drafted")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#now .send")).toHaveText("Send: file all five as drafted");
  await page.waitForTimeout(800);
  expect(answers).toHaveLength(0);
  await page.locator("#now .send").click();
  await expect.poll(async () => (await answered(page, "incident-action-items"))?.final).toBe("A");
});

test("thinking out loud: the choice, reason and condition are marked, and go with the answer verbatim", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  const words = "File all five as drafted because the volunteers agreed. As long as each ticket links the incident doc.";
  await think(page, words);
  await expect(page.locator(".think-marks .m-choice")).toHaveText("File all five as drafted");
  await expect(page.locator(".think-marks .m-why")).toHaveText("because the volunteers agreed.");
  await expect(page.locator(".think-marks .m-but")).toHaveText("As long as each ticket links the incident doc.");
  await expect(option(page, "File all five as drafted")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#now .send")).toHaveText("Send: file all five as drafted, with one condition");
  await page.locator("#now .send").click();
  await expect.poll(async () => (await answered(page, "incident-action-items"))?.final).toBe("A");
  const a = (await answered(page, "incident-action-items"))!;
  expect(a.basis).toBe("because the volunteers agreed.");
  expect(a.conditions).toBe("As long as each ticket links the incident doc.");
  expect(a.narration).toBe(words);
  expect(a.send_down).toContain("Conditions from Jordan: As long as each ticket links the incident doc.");
});

test("conditions are offered as guidance even when the choice matches the guess", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await think(page, "File all five as drafted. As long as each ticket links the incident doc.");
  await page.locator("#now .send").click();
  await expect(page.locator("#fact-text")).toBeVisible();
});

test("a course that is neither option is sent as something else, in the person's words", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await think(page, "Instead, assign the database one to me.");
  await expect(page.locator("#now .send")).toHaveText("Send: something else");
  await page.locator("#now .send").click();
  await expect.poll(async () => (await answered(page, "incident-action-items"))?.final).toBe("other");
  expect((await answered(page, "incident-action-items"))?.other).toBe("Instead, assign the database one to me.");
  await expect(page.locator("#now .followup .senddown")).toContainText("Instead, assign the database one to me.");
  await expect(page.locator("#now .followup").getByRole("button", { name: "Next decision" })).toBeVisible();
});

test("a question in the words is answered under them, from what the agent provided", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await think(page, "Are these fares refundable?");
  await expect(page.locator("#now .answers li.answered")).toContainText("refundable");
  await expect(option(page, "9:40am flight")).toBeEnabled();
});

test("an unanswered question can go back to the agent, and the decision waits", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await think(page, "Is there wifi aboard?");
  await expect(page.locator("#now .answers li.missing")).toBeVisible();
  await expect(page.locator("#now .send")).toHaveText("Ask the agent, and set this aside");
  await page.locator("#now .send").click();
  await expect.poll(async () => (await stored(page))?.punts?.["onsite-flight"]?.reason).toBe("Is there wifi aboard?");
});

test("the most recent signal picks: a click overrides what was said, a newly stated choice overrides the click", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await think(page, "Show me the list first.");
  await expect(option(page, "Show me the list first")).toHaveAttribute("aria-pressed", "true");
  await option(page, "File all five as drafted").click();
  await expect(option(page, "File all five as drafted")).toHaveAttribute("aria-pressed", "true");
  // More words that state no new choice leave the click alone.
  await think(page, "Show me the list first. Hmm, more thinking.");
  await expect(option(page, "File all five as drafted")).toHaveAttribute("aria-pressed", "true");
  // A newly stated choice (different from the last one read) takes over.
  await think(page, "Fine. File all five as drafted.");
  await think(page, "Show me the list first.");
  await expect(option(page, "Show me the list first")).toHaveAttribute("aria-pressed", "true");
});

test("deleting a spoken choice clears it; a clicked choice stays", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await think(page, "Show me the list first.");
  await expect(option(page, "Show me the list first")).toHaveAttribute("aria-pressed", "true");
  await think(page, "Not sure yet.");
  await expect(page.locator("#now .opt[aria-pressed='true']")).toHaveCount(0);
  await option(page, "File all five as drafted").click();
  await think(page, "Still not sure.");
  await expect(option(page, "File all five as drafted")).toHaveAttribute("aria-pressed", "true");
});

test("a parse of older words never lands on newer ones", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  const release = await hold(page, "/api/parse", (b) => b.text === "Show me the list first.");
  await page.locator("#think").fill("Show me the list first.");
  await page.waitForTimeout(1500); // its parse is out, and held
  await think(page, "Not sure yet.");
  release();
  await page.waitForTimeout(800);
  await expect(page.locator("#now .opt[aria-pressed='true']")).toHaveCount(0);
  await expect(page.locator(".think-marks mark")).toHaveCount(0);
});

test("Send is claimed once: a double click sends one answer", async ({ page }) => {
  const checks: string[] = [];
  page.on("request", (r) => r.url().includes("/api/answer") && r.postDataJSON()?.stage === "check" && checks.push(r.url()));
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await page.locator("#now .send").dblclick();
  await expect.poll(async () => (await answered(page, "incident-action-items"))?.final).toBe("A");
  expect(checks).toHaveLength(1);
});

test("Send waits for the final words to be read, and leaving the card meanwhile sends nothing", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  const release = await hold(page, "/api/parse");
  await page.locator("#think").fill("File all five as drafted because they agreed.");
  await page.locator("#now .send").click();
  await expect(page.locator("#now .think-msg")).toHaveText("Reading what you said…");
  await goHome(page);
  release();
  await page.waitForTimeout(1200);
  expect(await answered(page, "incident-action-items")).toBeUndefined();
});

test("a reload keeps the words and the pick, unsent", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await think(page, "Show me the list first because I want to check owners.");
  await page.reload();
  await expect(page.locator("#think")).toHaveValue("Show me the list first because I want to check owners.");
  await expect(option(page, "Show me the list first")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".think-marks .m-why")).toHaveText("because I want to check owners.");
  expect(await answered(page, "incident-action-items")).toBeUndefined();
});

test("typing keeps its focus and caret while marks arrive", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await page.locator("#think").click();
  await page.keyboard.type("Show me the list first.");
  await expect(page.locator(".think-marks .m-choice")).toBeVisible({ timeout: 5000 });
  expect(await page.evaluate("document.activeElement && document.activeElement.id")).toBe("think");
  await page.keyboard.type(" Because owners.");
  await expect(page.locator("#think")).toHaveValue("Show me the list first. Because owners.");
});

test("decide: pick, then Send", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await decide(page, "Show me the list first");
  await expect.poll(async () => (await answered(page, "incident-action-items"))?.final).toBe("B");
});

test("Not now is a quiet link, not a button competing with the options", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  const notNow = page.locator("#now .not-now");
  await expect(notNow).toBeVisible();
  await expect(notNow).toHaveClass(/linkish/);
});

test("at 320px: narration, marks, a long Send label, payload lines and prototypes fit without sideways scroll @narrow", async ({ page }) => {
  const wide = () => page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as Promise<number>;
  await openDecision(page, "incident-action-items");
  await think(page, "File all five as drafted because the volunteers already agreed in the meeting. As long as each ticket links the incident doc. Who owns the database item?");
  await expect(page.locator("#now .send")).toHaveText("Send: file all five as drafted, with one condition");
  expect(await wide(), "incident-action-items").toBeLessThanOrEqual(0);
  for (const id of ["api-rename", "settings-redesign"]) {
    await openDecision(page, id);
    await page.locator("#now .opt").first().click();
    expect(await wide(), id).toBeLessThanOrEqual(0);
  }
});
