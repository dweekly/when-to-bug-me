// Regression tests for the stage 1 integration review: the why prompt survives a reload, an answer
// is never overwritten by a stale re-check, a card that becomes settled leaves the screen, and an
// over-long reason can be shortened and resent.
import { expect, test } from "@playwright/test";
import { freshPage, openFromAgenda, option } from "./helpers";

const state = async (page: import("@playwright/test").Page) =>
  JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v1')")) as string);

async function editRule(page: import("@playwright/test").Page, id: string, text: string) {
  await page.getByRole("button", { name: new RegExp(`Edit rule ${id}`) }).click();
  await page.getByLabel(`Rule ${id}`).fill(text);
  await page.getByRole("button", { name: "Save and re-route" }).click();
}

async function flightToWhy(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "answer the 6:05am flight question" }).click();
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
  await editRule(page, "R8", "Ask me before accepting any meeting invite.");
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  await openFromAgenda(page, "Berlin team");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/route", async (route) => {
    if ((route.request().postDataJSON() as { id: string }).id === "berlin-sync") await gate;
    await route.continue();
  });
  await editRule(page, "R8", "Accept routine internal meeting invites; just do it.");
  await option(page, "Decline and propose a later slot").click();
  await page.locator("#basis").fill("Too early for school drop-off.");
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  await expect.poll(async () => (await state(page)).answered["berlin-sync"]?.final).toBe("B");
  release();
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  await expect(page.locator("#settled li").filter({ hasText: "Berlin team" })).toHaveCount(0);
});

test("a card that becomes settled leaves the screen", async ({ page }) => {
  await editRule(page, "R8", "Ask me before accepting any meeting invite.");
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  await openFromAgenda(page, "Berlin team");
  await editRule(page, "R8", "Accept routine internal meeting invites; just do it.");
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  await expect(page.locator("#now-q")).not.toContainText("Berlin team");
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
