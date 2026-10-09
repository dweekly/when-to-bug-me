// Every guided tour, start to finish, on the recorded Claude run with no API key (the "recorded"
// projects in playwright.config.ts). The visitor's part of each step is played by the test: press
// Next, click what the step asks for, or (for steps that finish when something appears) do what the
// step's text asks. A step that never appears fails the test, except steps the catalog marks optional.
import { type Page, expect, test } from "@playwright/test";
import { TOURS, type TourStep } from "../../src/shared/tours";

async function popoverTitle(page: Page): Promise<string | null> {
  const t = page.locator(".driver-popover-title");
  return (await t.count()) ? (await t.first().textContent()) : null;
}

/** Do what the step asks, as a visitor would. */
async function act(page: Page, step: TourStep): Promise<void> {
  const example = page.locator(".driver-popover .bm-example");
  if (step.until === "next") {
    await page.locator(".driver-popover-next-btn").click();
    return;
  }
  if ("event" in step.until) {
    // The set-aside step: pick what you'd need, give the sentence, set it aside.
    await page.locator(".chip-btn").nth(1).click();
    await page.locator(".driver-popover .bm-example").click();
    await page.locator("#now .punt .primary").click();
    return;
  }
  if ("click" in step.until) {
    // Setting aside needs a kind picked before the sentence.
    if (step.until.click.includes(".punt")) await page.locator(".chip-btn").nth(1).click();
    if (await example.count()) await example.click();
    await page.locator(step.until.click).first().click();
    return;
  }
  // Steps that finish when something appears: the why prompt, keeping guidance, setting aside.
  if (step.until.appear === "#fact-text") {
    await example.click();
    await page.locator("#now .followup .primary").first().click();
  } else {
    await page.locator("#now .followup .actions .primary").first().click(); // Keep it
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/app#/");
  await page.evaluate("localStorage.clear()");
});

for (const tour of TOURS) {
  test(`tour “${tour.title}” runs start to finish on the recorded run`, async ({ page }) => {
    const q = (await (await page.request.get("/api/queue")).json()) as { mode: string };
    expect(q.mode).toBe("recorded");
    await page.goto(`/app?tour=${tour.id}#/`);
    for (const step of tour.steps) {
      if (step.optional) {
        // Optional steps appear only on some paths; take them when they do.
        const appeared = await expect
          .poll(() => popoverTitle(page), { timeout: 4_000 })
          .toBe(step.title)
          .then(() => true, () => false);
        if (!appeared) continue;
      } else {
        await expect.poll(() => popoverTitle(page), { timeout: 15_000, message: `waiting for step “${step.title}”` }).toBe(step.title);
      }
      await act(page, step);
    }
    await expect.poll(() => popoverTitle(page), { timeout: 15_000 }).toBe(`That's “${tour.title}”.`);
    await expect(page.getByText("Couldn't evaluate")).toHaveCount(0);
    await expect(page.getByText("only recorded answers are available")).toHaveCount(0);
  });
}
