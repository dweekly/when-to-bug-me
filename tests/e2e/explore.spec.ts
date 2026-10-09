// Explored options (build plan, item 5): the settings redesign arrives with two clickable variants,
// sandboxed to scripts only.
import { expect, test } from "@playwright/test";
import { freshPage, openFromAgenda } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("the settings redesign shows two sandboxed, clickable variants", async ({ page }) => {
  await openFromAgenda(page, "Settings page redesign");
  const frames = page.locator("#now iframe");
  await expect(frames).toHaveCount(2);
  for (let i = 0; i < 2; i++) await expect(frames.nth(i)).toHaveAttribute("sandbox", "allow-scripts");

  const a = page.locator('#now iframe[title="Clickable prototype, option A"]');
  await a.scrollIntoViewIfNeeded();
  const frame = page.frameLocator('#now iframe[title="Clickable prototype, option A"]');
  await expect(frame.locator("#p-profile")).toBeVisible();
  await expect(frame.locator("#p-notifications")).toBeHidden();

  await frame.getByRole("tab", { name: "Notifications" }).click();
  await expect(frame.locator("#p-notifications")).toBeVisible();
  await expect(frame.locator("#p-profile")).toBeHidden();
  await expect(frame.getByRole("tab", { name: "Notifications" })).toHaveAttribute("aria-selected", "true");
});
