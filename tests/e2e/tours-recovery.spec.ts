// Recovery on the keyless recorded server (the "recorded" projects in playwright.config.ts), the
// reproductions from the submission review (issue #62): after the main loop keeps guidance, another
// card's DEMO REPLY no longer matches a recording (#51); a "Huh?" with no recording fails (#58).
import { type Page, expect, test } from "@playwright/test";

const demoReply = (page: Page) => page.locator("#now .composer .demo-reply");
const sendBtn = (page: Page) => page.locator("#now .send");
async function bugReplied(page: Page, n: number): Promise<void> {
  await expect(page.locator("#now .turns li.bug:not(.typing)")).toHaveCount(n, { timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/app#/");
  await page.evaluate("localStorage.clear()");
  await page.reload();
  const q = (await (await page.request.get("/api/queue")).json()) as { mode: string };
  expect(q.mode).toBe("recorded");
});

test("#51: after keeping the flight guidance, the API card can still be decided, and says why Bug Me can't reply", async ({ page }) => {
  // The main loop, as Start here plays it: Jordan's two recorded turns, decide, keep the guidance.
  await page.goto("/app#/d/onsite-flight");
  for (const n of [1, 2]) {
    await demoReply(page).click();
    await sendBtn(page).click();
    await bugReplied(page, n);
  }
  await page.locator("#now .send.decide").click();
  await expect(page.locator("#fact-text")).toBeVisible({ timeout: 15_000 });
  await page.locator("#now .followup .actions .primary").click();
  await expect(page.locator("#now .followup .senddown")).toBeVisible({ timeout: 15_000 });

  // Another card: its recorded reply was made before that guidance existed, so there is no recording.
  await page.goto("/app#/d/api-rename");
  await demoReply(page).click();
  await sendBtn(page).click();
  const unread = page.locator("#now .unread");
  await expect(unread).toBeVisible({ timeout: 15_000 });
  await expect(unread).toContainText("Jordan's recorded run");
  await unread.locator(".decide-unread", { hasText: "Keep" }).click();
  await expect(page.locator("#now .followup .senddown")).toContainText("words, as said", { timeout: 15_000 });
  // Guidance needs a model too; it says so and leaves a retry instead of ending the loop.
  await expect(page.locator("#now .retry-guidance")).toBeVisible();
});

test("#58: a Huh? with no recording can be replaced by Jordan's recorded reply", async ({ page }) => {
  await page.goto("/app#/d/onsite-flight");
  await page.locator("#now .huh-row .huh").click();
  await expect(page.locator("#now .unread")).toBeVisible({ timeout: 15_000 });
  await demoReply(page).click();
  await expect(sendBtn(page)).toHaveText("Send");
  await sendBtn(page).click();
  await bugReplied(page, 1);
  await expect(page.locator("#now .turns .huh-turn")).toHaveCount(0);
  await expect(page.locator("#now .unread")).toBeHidden();
});
