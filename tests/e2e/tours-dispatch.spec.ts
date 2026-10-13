// The public Dispatch demo on the recorded run (no key; docs/STAGE-8.md): each demo task's brief is
// Claude's, replayed for free. Named tours-* so it runs on the recorded server.
import { expect, test } from "@playwright/test";
import { DISPATCH_EXAMPLES } from "../../src/shared/dispatchExamples";

test.beforeEach(async ({ page }) => {
  await page.goto("/app#/");
  await page.evaluate("localStorage.clear()");
});

for (const x of DISPATCH_EXAMPLES) {
  test(`the "${x.label}" brief is a recorded Claude run`, async ({ page }) => {
    await page.goto("/app#/dispatch");
    await page.locator(`.demo-chip[data-example="${x.id}"]`).click();
    await page.locator("#draft-brief").click();
    await expect(page.locator("#brief header .turn-src")).toHaveText("recorded Claude run");
    await expect(page.locator("#brief .brief-size")).toBeVisible();
    if (x.id === "billing-complaints") {
      await expect(page.locator("#brief .brief-where")).toContainText("Run locally.");
      await expect(page.locator("#copy-command")).toHaveText("Run in the cloud anyway");
    }
    if (x.id === "pagerduty") await expect(page.locator("#copy-command")).toBeDisabled();
    expect(await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")).toBeLessThanOrEqual(0);
  });
}
