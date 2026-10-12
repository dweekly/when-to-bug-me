// Regression tests for the stage 2 tour review, on the recorded run: a rejected set-aside does not
// advance the tour, Tab reaches the options during a step, a tour started on its own card shows a fresh
// card, a slow typist is not stranded, Escape inside a prototype ends the tour, a reason that can't be
// checked or is skipped offers a way on.
import { type Page, expect, test } from "@playwright/test";

const title = (page: Page) => page.locator(".driver-popover-title");

/** After deciding on the flight (and the Undo window), the recorded run brings pushback first; take it (an exception) if it comes. */
async function passPushback(page: Page): Promise<void> {
  await expect(title(page)).toHaveText(/Pushback, from your own rules|I'm curious: why\?/, { timeout: 10_000 });
  if ((await title(page).textContent()) === "Pushback, from your own rules") await page.locator("#now .followup.push .primary").click();
  await expect(title(page)).toHaveText("I'm curious: why?");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/app#/");
  await page.evaluate("localStorage.clear()");
});

test("a set-aside the app rejects keeps the tour on that step", async ({ page }) => {
  await page.goto("/app?tour=start-here#/");
  // Jump the tour forward by doing the steps quickly up to "What would you need?".
  for (const t of ["Start here", "Then, in order", "Code said no", "See it, don't read it"]) {
    await expect(title(page)).toHaveText(t);
    await page.locator(".driver-popover-next-btn").click();
  }
  await page.locator("#now .opt").nth(1).click();
  await page.locator("#now .send").click();
  await passPushback(page);
  await page.locator(".driver-popover .bm-example").click();
  await page.locator("#now .followup .primary").first().click();
  await page.locator("#now .followup .actions .primary").first().click();
  await page.locator("#now .rerouted button").click();
  await page.locator("#now .skip-q").click();
  await expect(title(page)).toHaveText("What would you need?");
  await page.locator("#now .punt .primary").click(); // no kind chosen: rejected
  await expect(page.locator("#now .punt [role=alert]")).toBeVisible();
  await expect(title(page)).toHaveText("What would you need?");
});

test("Tab reaches the options while a step highlights the think-out-loud box", async ({ page }) => {
  await page.goto("/app?tour=rule-quoted#/");
  for (const t of ["Why it's yours", "Each option, whole"]) {
    await expect(title(page)).toHaveText(t);
    await page.locator(".driver-popover-next-btn").click();
  }
  await expect(title(page)).toHaveText("Think out loud");
  await page.locator("#think").fill("Renames break integrators.");
  await page.locator("#think").focus();
  let reached = false;
  // The options come before the think box in reading order, so Shift+Tab walks back to them.
  for (let i = 0; i < 8 && !reached; i++) {
    await page.keyboard.press("Shift+Tab");
    reached = await page.evaluate("Boolean(document.activeElement?.closest('#now .opt'))");
  }
  expect(reached).toBe(true);
});

test("starting a tour from its own card shows a fresh card", async ({ page }) => {
  await page.goto("/app#/d/onsite-flight");
  await page.locator("#now .opt").nth(0).click(); // some progress on this card
  await page.goto("/app?tour=say-why#/d/onsite-flight");
  await expect(title(page)).toHaveText("Code said no");
  await expect(page.locator("#now .opt[aria-pressed=true]")).toHaveCount(0);
  await page.locator(".driver-popover-next-btn").click();
  await page.locator("#now .opt").nth(1).click();
  await expect(page.locator("#now .opt").nth(1)).toHaveAttribute("aria-pressed", "true");
});

test("a slow typist is not stranded at the why step", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/app?tour=say-why#/");
  await expect(title(page)).toHaveText("Code said no");
  await page.locator(".driver-popover-next-btn").click();
  await page.locator("#now .opt").nth(1).click();
  await page.locator("#now .send").click();
  await passPushback(page);
  await expect(title(page)).toHaveText("I'm curious: why?");
  await page.waitForTimeout(13_000); // longer than a step's normal wait
  await page.locator(".driver-popover .bm-example").click();
  await page.locator("#now .followup .primary").first().click();
  await expect(title(page)).toHaveText("Guidance", { timeout: 15_000 });
});

test("Escape inside a settings prototype ends the tour", async ({ page }) => {
  await page.goto("/app?tour=explore#/");
  await expect(title(page)).toHaveText("Both built");
  const frame = page.frameLocator(".variant iframe").first();
  await frame.locator("button").first().click();
  await frame.locator("body").press("Escape");
  await expect(page.locator(".driver-popover")).toHaveCount(0);
});

test("a typed reason with no recorded answer says so and offers to start again", async ({ page }) => {
  await page.goto("/app?tour=say-why#/");
  await expect(title(page)).toHaveText("Code said no");
  await page.locator(".driver-popover-next-btn").click();
  await page.locator("#now .opt").nth(1).click();
  await page.locator("#now .send").click();
  await passPushback(page);
  await page.locator("#why").fill("I prefer a later flight because I cannot leave home until after school drop-off.");
  await page.locator("#now .followup .primary").first().click();
  await expect(title(page)).toHaveText("That reason couldn't be checked");
  await expect(page.locator(".driver-popover-description")).toContainText("no live Claude connection");
  await page.locator(".driver-popover-next-btn").click(); // Start again
  await expect(title(page)).toHaveText("Code said no");
});


test("skipping the why says so and offers to start again", async ({ page }) => {
  await page.goto("/app?tour=say-why#/");
  await expect(title(page)).toHaveText("Code said no");
  await page.locator(".driver-popover-next-btn").click();
  await page.locator("#now .opt").nth(1).click();
  await page.locator("#now .send").click();
  await passPushback(page);
  await page.locator("#now .followup").getByRole("button", { name: "skip" }).click();
  await expect(title(page)).toHaveText("No guidance from that one");
  await page.locator(".driver-popover-next-btn").click(); // Start again
  await expect(title(page)).toHaveText("Code said no");
});
