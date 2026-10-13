// On the recorded run (no key): the options are in Jordan's terms from the recorded titles, the agent's
// own labels are under More context, and DEMO REPLY carries the conversation on recorded replies to a
// decision button in the same words (docs/STAGE-6F.md). Named tours-* so it runs on the recorded server.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/app#/");
  await page.evaluate("localStorage.clear()");
});

test("the T-19 card speaks Jordan's language, and DEMO REPLY reaches a decision in it", async ({ page }) => {
  await page.goto("/app#/d/reconciliation-path");
  const labels = page.locator("#now .opt .opt-label");
  await expect(labels).toHaveText(["Recheck and fix invoices since January", "Keep using the old tax table"]);
  await expect(page.locator("#now .options")).not.toContainText("T-19");
  await page.locator("#now details.more summary").click();
  await expect(page.locator("#now details.more")).toContainText("The agent's options: A. Apply v2 reconciliation path · B. Keep T-19 mapping");
  await page.locator("#now .composer .demo-reply").click();
  await expect(page.locator("#think")).toHaveValue(/^Keep the old tax table\./);
  await page.locator("#now .send").click();
  const decide = page.locator("#now .send.decide");
  await expect(decide).toHaveText("Keep using the old tax table");
  await expect(page.locator("#now .turns li.bug").last()).toContainText("old tax table");
  await expect(page.locator("#now .turns .turn-src").last()).toHaveText("recorded");
});
