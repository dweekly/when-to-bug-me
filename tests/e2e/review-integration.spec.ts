// Regression tests for the stage 1 integration review: the why prompt survives a reload, an answer
// is never overwritten by a stale re-check, a card that becomes settled leaves the screen, and an
// over-long reason can be shortened and resent.
//
// The two re-check tests use the SDK-comparison time-budget question: it starts as a quick check-in,
// and rewriting R10 to "just do it" makes the fake model settle it (reversible, free, cleared by a
// whole rule), so the re-check really would take it off the person's hands.
import { expect, test } from "@playwright/test";
import { editRule, freshPage, goSettled, hold, openDecision, option } from "./helpers";

const state = async (page: import("@playwright/test").Page) =>
  JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v1')")) as string);

const BUDGET = "sdk-comparison-budget";
const R10_CLEARS = "If a task runs past twice its time budget, just do it.";

async function flightToWhy(page: import("@playwright/test").Page) {
  await openDecision(page, "onsite-flight");
  await option(page, "9:40am flight").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("the why prompt survives a reload", async ({ page }) => {
  await flightToWhy(page);
  await page.reload();
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
});

test("an answer given while a re-check is out is not overwritten by it", async ({ page }) => {
  await openDecision(page, BUDGET);
  const release = await hold(page, "/api/route", (b) => b.id === BUDGET);
  await editRule(page, "R10", R10_CLEARS);
  await expect.poll(async () => (await state(page)).pending).toEqual([BUDGET]);
  await openDecision(page, BUDGET);
  await option(page, "Keep going").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  await expect.poll(async () => (await state(page)).answered[BUDGET]?.final).toBe("B");
  release();
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  const s = await state(page);
  expect(s.answered[BUDGET].final).toBe("B");
  // The late re-check (which would have settled it) did not replace the answered card.
  expect(s.cards[BUDGET].route).toBe("check_in");
  await goSettled(page);
  await expect(page.locator("#settled li").filter({ hasText: "SDK comparison" })).toHaveCount(0);
});

test("a card that becomes settled leaves the screen", async ({ page }) => {
  await openDecision(page, BUDGET);
  const release = await hold(page, "/api/route", (b) => b.id === BUDGET);
  await editRule(page, "R10", R10_CLEARS);
  await expect.poll(async () => (await state(page)).pending).toEqual([BUDGET]);
  // Back on the card while its re-check is still out; the re-check then settles it.
  await openDecision(page, BUDGET);
  await expect(page.locator("#now-q")).toContainText("SDK comparison");
  release();
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  await expect(page.locator("#now-q")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/settled$/);
  await expect(page.locator("#settled li").filter({ hasText: "SDK comparison" })).toHaveCount(1);
});

test("an over-long reason can be shortened and resent", async ({ page }) => {
  await flightToWhy(page);
  await page.getByLabel("Why did you choose that?").fill("x".repeat(601));
  await page.getByRole("button", { name: "Tell Bug Me" }).click();
  await expect(page.locator("#now [role=alert]")).toContainText("under 600 characters");
  await page.getByLabel("Why did you choose that?").fill("I do school drop-off before 8:30.");
  await page.getByRole("button", { name: "Tell Bug Me" }).click();
  await expect(page.getByRole("button", { name: "Keep it" })).toBeVisible();
});
