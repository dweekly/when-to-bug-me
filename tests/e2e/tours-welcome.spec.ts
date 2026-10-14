// Stage 10a (docs/STAGE-10.md) on the recorded run, as a keyless deployment serves it: the interview's
// revision exists only for Jordan's three recorded answers, and the tour starts from the top even after
// onboarding was done by hand.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/app#/");
  await page.evaluate("localStorage.clear()");
});

test("with no key, Revise waits for all three of Jordan's answers, and says why", async ({ page }) => {
  await page.goto("/app#/welcome");
  await page.locator("#draft-note").click();
  await page.locator("#start-interview").click();
  const demos = page.locator("#step-interview .demo-reply");
  await expect(demos).toHaveCount(3);
  await demos.nth(0).click();
  await expect(page.locator("#revise-note")).toBeDisabled();
  await expect(page.locator("#revise-why")).toContainText("DEMO REPLY");
  await demos.nth(1).click();
  await demos.nth(2).click();
  await expect(page.locator("#revise-note")).toBeEnabled();
  await page.locator("#revise-note").click();
  await expect(page.locator("#step-note .change-changed").first()).toBeVisible();
  await expect(page.getByText("Couldn't do that")).toHaveCount(0);
});

test("the tour starts from the top after onboarding was done by hand", async ({ page }) => {
  await page.goto("/app#/welcome");
  await page.locator("#draft-note").click();
  await expect(page.locator("#step-draft")).toBeVisible();
  await page.locator(".tours-btn").click();
  await page.locator('.tour-item[data-tour="welcome"]').click();
  await expect(page.locator(".driver-popover-title")).toHaveText("It reads first");
  await expect(page.locator("#draft-note")).toBeVisible();
});
