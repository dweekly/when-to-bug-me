// Layout and motion: no horizontal scroll at phone width, and no card animation under reduced motion.
import { expect, test } from "@playwright/test";
import { freshPage, openFromAgenda } from "./helpers";

const NO_HSCROLL = "document.documentElement.scrollWidth <= window.innerWidth";
const OVERFLOW = "({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })";

test.describe("phone layout", () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "phone-width check");
    await freshPage(page);
  });

  test("no horizontal scroll on load or with the settings card open", async ({ page }) => {
    expect(await page.evaluate(NO_HSCROLL), JSON.stringify(await page.evaluate(OVERFLOW))).toBe(true);
    await openFromAgenda(page, "Settings page redesign");
    await expect(page.locator("#now iframe")).toHaveCount(2);
    expect(await page.evaluate(NO_HSCROLL), JSON.stringify(await page.evaluate(OVERFLOW))).toBe(true);
  });
});

const CARD_ANIMATION = "getComputedStyle(document.querySelector('#now .card')).animationName";

test.describe("motion", () => {
  test("cards animate by default (so the reduced-motion check below can fail)", async ({ page }) => {
    await freshPage(page);
    expect(await page.evaluate(CARD_ANIMATION)).not.toBe("none");
  });

  test.describe("with reduced motion", () => {
    test.use({ reducedMotion: "reduce" });
    test("cards do not animate", async ({ page }) => {
      await freshPage(page);
      expect(await page.evaluate(CARD_ANIMATION)).toBe("none");
    });
  });
});
