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
  // Nothing to press first: Bug Me reads and asks on its own (issue #71).
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
  await expect(page.locator("#step-interview")).toBeVisible();
  await page.locator("#step-interview .demo-reply").first().click();
  await page.locator(".tours-btn").click();
  await page.locator('.tour-item[data-tour="welcome"]').click();
  await expect(page.locator(".driver-popover-title")).toHaveText("It reads first");
  // Started over: the answer typed before is gone, and it has read and asked again on its own.
  await expect(page.locator("#step-interview")).toBeVisible();
  await expect(page.locator("#answer-q1")).toHaveValue("");
});

test("a read still out when the tour restarted onboarding is dropped, and the restart reads again", async ({ page }) => {
  await page.goto("/app#/welcome");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/onboarding/draft", async (route) => {
    await held;
    await route.continue();
  });
  await page.locator(".tours-btn").click();
  await page.locator('.tour-item[data-tour="welcome"]').click();
  await expect(page.locator(".driver-popover-title")).toHaveText("It reads first");
  release();
  // The read from before the restart is dropped; the restart's own read lands, once, with no error.
  await expect(page.locator("#step-draft")).toHaveCount(1);
  await expect(page.locator("#step-interview")).toBeVisible();
  await expect(page.getByText("Couldn't do that")).toHaveCount(0);
});
