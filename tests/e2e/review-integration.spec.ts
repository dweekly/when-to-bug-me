// Regression tests for the stage 1 integration review: the why prompt survives a reload, an answer
// is never overwritten by a stale re-check, a card that becomes settled leaves the screen, and an
// over-long reason can be shortened and resent.
//
// The two re-check tests use the settings redesign: it starts as a quick check-in, and rewriting R11
// to clear UI layout choices makes the fake model settle it (reversible, free, cleared by a whole
// rule), so the re-check really would take it off the person's hands.
import { expect, test } from "@playwright/test";
import { editRule, freshPage, goSettled, hold, openDecision, option, decide, decideQuietly } from "./helpers";

const state = async (page: import("@playwright/test").Page) =>
  JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v4')")) as string);

const BUDGET = "settings-redesign";
const R11_CLEARS = "UI layout choices on a preview branch: just do it.";

async function flightToWhy(page: import("@playwright/test").Page) {
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  await expect(page.locator("#now .why-lead")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("the why prompt survives a reload", async ({ page }) => {
  await flightToWhy(page);
  await page.reload();
  await expect(page.locator("#now .why-lead")).toBeVisible();
});

test("an answer given while a re-check is out is not overwritten by it", async ({ page }) => {
  await openDecision(page, BUDGET);
  const release = await hold(page, "/api/route", (b) => b.id === BUDGET);
  await editRule(page, "R11", R11_CLEARS);
  await expect.poll(async () => (await state(page)).pending).toEqual([BUDGET]);
  await openDecision(page, BUDGET);
  await decide(page, "One page");
  await expect.poll(async () => (await state(page)).answered[BUDGET]?.final).toBe("B");
  release();
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  const s = await state(page);
  expect(s.answered[BUDGET].final).toBe("B");
  // The late re-check (which would have settled it) did not replace the answered card.
  expect(s.cards[BUDGET].route).toBe("check_in");
  await goSettled(page);
  await expect(page.locator("#settled li").filter({ hasText: "Settings page redesign" })).toHaveCount(0);
});

test("a card that becomes settled leaves the screen", async ({ page }) => {
  await openDecision(page, BUDGET);
  const release = await hold(page, "/api/route", (b) => b.id === BUDGET);
  await editRule(page, "R11", R11_CLEARS);
  await expect.poll(async () => (await state(page)).pending).toEqual([BUDGET]);
  // Back on the card while its re-check is still out; the re-check then settles it.
  await openDecision(page, BUDGET);
  await expect(page.locator("#now-q")).toContainText("Settings page");
  release();
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  await expect(page.locator("#now-q")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/settled$/);
  await expect(page.locator("#settled li").filter({ hasText: "Settings page redesign" })).toHaveCount(1);
});

test("an over-long reason can be shortened and resent", async ({ page }) => {
  await flightToWhy(page);
  await page.getByLabel("Why did you choose that?").fill("x".repeat(901));
  await page.getByRole("button", { name: "Tell Bug Me" }).click();
  await expect(page.locator("#now [role=alert]")).toContainText("under 900 characters");
  await page.getByLabel("Why did you choose that?").fill("I do school drop-off before 8:30.");
  await page.getByRole("button", { name: "Tell Bug Me" }).click();
  await expect(page.getByRole("button", { name: "Keep it" })).toBeVisible();
});
