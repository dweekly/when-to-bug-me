// The explainer at "/": its numbers come from /api/queue, its piles match Home's (one recommended),
// and every tour card opens that tour in the app.
import { expect, test } from "@playwright/test";
import { TOURS } from "../../src/shared/tours";

test("counts come from the queue, and there is exactly one recommended pile", async ({ page }) => {
  const q = (await (await page.request.get("/api/queue")).json()) as { decisions: unknown[] };
  await page.goto("/");
  await expect(page.locator('[data-count="total"]')).toHaveText(String(q.decisions.length));
  await expect(page.locator(".pile.rec")).toHaveCount(1);
  await expect(page.locator(".pile.rec .pile-head")).toHaveText(/^Suggested first: /);
});

test("every tour card opens its tour in the app", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator("[data-tours] a");
  await expect(cards).toHaveCount(TOURS.length);
  for (const t of TOURS) await expect(page.locator(`[data-tours] a[data-tour="${t.id}"]`)).toHaveAttribute("href", `/app?tour=${t.id}`);
  await page.locator('[data-tours] a[data-tour="start-here"]').click();
  await expect(page.locator(".driver-popover-title")).toHaveText("Start here");
});

test("no horizontal scroll at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await expect(page.locator(".pile").first()).toBeAttached();
  expect(await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")).toBeLessThanOrEqual(0);
});
