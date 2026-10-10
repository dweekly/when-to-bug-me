// Stage 3's decision card (docs/STAGE-3.md): a briefing before the question, clicking an option
// decides (with an Undo window), the Why panel is optional, and the other ways to answer: "Yes,
// but…", "Something else" and "Ask a question". On the fake-model server.
import { type Page, expect, test } from "@playwright/test";
import { freshPage, goHome, hold, openDecision, option, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

/** Give the Undo window a real length for the tests that are about it. */
async function undoWindow(page: Page, ms: number): Promise<void> {
  await page.evaluate(`localStorage.setItem('bugme.undoMs', '${ms}')`);
  await page.reload();
}

test("the briefing comes before the question, and there is no Decide button", async ({ page }) => {
  await openDecision(page, "api-rename");
  const order = await page.evaluate(
    "Boolean(document.querySelector('#now .briefing').compareDocumentPosition(document.querySelector('#now-q')) & Node.DOCUMENT_POSITION_FOLLOWING)",
  );
  expect(order).toBe(true);
  await expect(page.locator("#now").getByRole("button", { name: "Decide", exact: true })).toHaveCount(0);
  await expect(page.locator("#now .opt .procon").first()).toBeVisible();
});

test("Undo withdraws the choice before anything is sent; waiting it out records the answer", async ({ page }) => {
  await undoWindow(page, 1500);
  const answers: string[] = [];
  page.on("request", (r) => r.url().includes("/api/answer") && answers.push(r.url()));
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await expect(page.locator(".undo-bar")).toBeVisible();
  await page.locator(".undo-bar").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".undo-bar")).toHaveCount(0);
  await expect(option(page, "File all five as drafted")).toBeEnabled();
  await page.waitForTimeout(1800);
  expect(answers).toHaveLength(0);
  expect((await stored(page))?.answered?.["incident-action-items"]).toBeUndefined();

  await option(page, "File all five as drafted").click();
  await expect.poll(async () => (await stored(page))?.answered?.["incident-action-items"]?.final, { timeout: 5000 }).toBe("A");
});

test("leaving the card during the Undo window does not send the answer", async ({ page }) => {
  await undoWindow(page, 1500);
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await page.locator("a", { hasText: "Home" }).first().click();
  await page.waitForTimeout(2000);
  expect((await stored(page))?.answered?.["incident-action-items"]).toBeUndefined();
});

test("a reason typed in the Why panel before clicking goes with the answer", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await page.locator("#basis").fill("The volunteers already agreed in the meeting; no need to review.");
  await option(page, "File all five as drafted").click();
  await expect.poll(async () => (await stored(page))?.answered?.["incident-action-items"]?.basis).toContain("volunteers already agreed");
});

test("Yes, but… sends the conditions with the chosen option", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await page.getByRole("button", { name: "Yes, but…" }).click();
  await expect(page.locator(".why-panel label")).toContainText("Your conditions");
  await page.locator("#basis").fill("as long as each ticket links the incident doc");
  await option(page, "File all five as drafted").click();
  await expect.poll(async () => (await stored(page))?.answered?.["incident-action-items"]?.conditions).toBe("as long as each ticket links the incident doc");
  const a = (await stored(page))!.answered["incident-action-items"];
  expect(a.final).toBe("A");
  expect(a.send_down).toContain("as long as each ticket links the incident doc");
});

test("Something else records the option the person wrote", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await page.getByRole("button", { name: "Something else" }).click();
  await page.locator("#other").fill("File them, but assign the database one to me");
  await page.getByRole("button", { name: "Send this instead" }).click();
  await expect.poll(async () => (await stored(page))?.answered?.["incident-action-items"]?.final).toBe("other");
  const a = (await stored(page))!.answered["incident-action-items"];
  expect(a.other).toBe("File them, but assign the database one to me");
  expect(a.send_down).toContain("Instead: File them, but assign the database one to me");
});

test("Ask a question: an answer from what the agent provided is shown and labeled", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await page.getByRole("button", { name: "Ask a question" }).click();
  await page.locator("#question").fill("Are these fares refundable?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const ans = page.locator(".ask-answer");
  await expect(ans).toContainText("refundable");
  await expect(ans).toContainText("code stand-in");
  await expect(option(page, "9:40am flight")).toBeEnabled();
});

test("Ask a question: when the agent's notes don't say, the question goes back to it and the decision waits", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await page.getByRole("button", { name: "Ask a question" }).click();
  await page.locator("#question").fill("Is there wifi aboard?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".ask-answer.missing")).toBeVisible();
  await page.getByRole("button", { name: "Ask the agent, and set this aside" }).click();
  await expect.poll(async () => (await stored(page))?.punts?.["onsite-flight"]?.reason).toBe("Is there wifi aboard?");
});

test("Not now is a quiet link, not a button competing with the options", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  const notNow = page.locator("#now .not-now");
  await expect(notNow).toBeVisible();
  await expect(notNow).toHaveClass(/linkish/);
});

test("Something else ends with what the agent was told and a Next button", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await page.getByRole("button", { name: "Something else" }).click();
  await page.locator("#other").fill("File them, but assign the database one to me");
  await page.getByRole("button", { name: "Send this instead" }).click();
  await expect(page.locator("#now .senddown")).toContainText("Instead: File them");
  await expect(page.locator("#now").getByRole("button", { name: "Next decision" })).toBeVisible();
});

test("leaving and coming back inside the Undo window does not send the answer", async ({ page }) => {
  await undoWindow(page, 2000);
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await goHome(page);
  await openDecision(page, "incident-action-items");
  await page.waitForTimeout(2500);
  expect((await stored(page))?.answered?.["incident-action-items"]).toBeUndefined();
  await expect(page.locator("#now")).toContainText("Not sent");
});

test("Yes, but… offers its conditions as guidance even when the choice matches the guess", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await page.getByRole("button", { name: "Yes, but…" }).click();
  await page.locator("#basis").fill("as long as each ticket links the incident doc");
  await option(page, "File all five as drafted").click();
  await expect(page.locator("#now .followup")).toContainText(/Remember this|Got it/);
});

test("an answer to an earlier question never replaces the answer to a newer one", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  const release = await hold(page, "/api/ask", (b) => String(b.question).includes("refundable"));
  await page.getByRole("button", { name: "Ask a question" }).click();
  await page.locator("#question").fill("Are these fares refundable?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.locator("#question").fill("Is there wifi aboard?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".ask-answer.missing")).toBeVisible();
  release();
  await page.waitForTimeout(500);
  await expect(page.locator(".ask-answer.missing")).toBeVisible();
  await expect(page.locator(".ask-answer")).not.toContainText("refundable for 24 hours");
});

test("a reload during the Undo window brings the choice back unsent, with the reason", async ({ page }) => {
  await undoWindow(page, 3000);
  await openDecision(page, "incident-action-items");
  await page.locator("#basis").fill("Volunteers already agreed.");
  await option(page, "File all five as drafted").click();
  await page.reload();
  await expect(page.locator("#basis")).toHaveValue("Volunteers already agreed.");
  await expect(page.locator("#now")).toContainText("reloaded before that answer was sent");
  expect((await stored(page))?.answered?.["incident-action-items"]).toBeUndefined();
});
