// The core loop (build plan, "Intent"): answer the 6:05am flight question against Bug Me's hidden
// guess, get asked "I'm curious: why?", keep the reason as a standing fact, and watch the Berlin sync
// get re-checked because of it (and its note say it is now framed by what you said) while an
// unrelated settled decision stays put. Accepting a meeting is only partly reversible, so code never
// lets Bug Me settle the Berlin invite alone: it starts as a quick check-in.
import { expect, test } from "@playwright/test";
import { freshPage, goHome, goRules, goSettled, openDecision, option, stored, decide, decideQuietly } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("flight -> why -> kept fact -> Berlin sync re-checked and reframed, formatter run unchanged", async ({ page }) => {
  await goSettled(page);
  const formatter = page.locator("#settled li").filter({ hasText: "Run the formatter across the SDK repo" });
  await expect(formatter).toHaveCount(1);
  const formatterBefore = await formatter.innerText();
  // Berlin is never settled alone: it is a quick check-in on the Billing agenda.
  await expect(page.locator("#settled li").filter({ hasText: "Berlin team" })).toHaveCount(0);
  await goHome(page);
  const berlin = page.locator("#agenda a.item").filter({ hasText: "Berlin team" });
  await expect(berlin).toBeVisible();
  await expect(berlin.locator(".glyph")).toHaveAttribute("aria-label", "Quick check-in");
  await expect(berlin.locator(".change-note")).toHaveCount(0);

  await openDecision(page, "onsite-flight");
  await expect(page.locator("#now-q")).toContainText("6:05am flight");
  await decideQuietly(page, "9:40am flight");

  await expect(page.getByText("I'm curious: why?")).toBeVisible();
  await expect(page.getByText("hidden until now")).toHaveCount(0);

  await page.getByLabel("Why did you choose that?").fill("I do school drop-off before 8:30, so no early-morning flights for me.");
  await page.getByRole("button", { name: "Tell Bug Me" }).click();

  const guessLine = page.locator("#now").getByText("Bug Me's guess, hidden until now:");
  await expect(guessLine).toBeVisible();
  await expect(page.locator("#now")).toContainText("You went the other way.");

  await page.getByRole("button", { name: "Keep it" }).click();
  // The answered card lists what the kept guidance changed, Berlin among it.
  const rerouted = page.locator("#now .rerouted").filter({ hasText: "Berlin team" });
  await expect(rerouted).toContainText("Now framed by what you said");
  await expect(rerouted).toContainText("No commitments before 8:30am");

  await goRules(page);
  await expect(page.locator("#facts")).toContainText("No commitments before 8:30am");

  await goHome(page);
  await expect(berlin).toBeVisible();
  const note = berlin.locator(".change-note");
  await expect(note).toContainText("Now framed by what you said");
  await expect(note).toContainText("No commitments before 8:30am");

  await goSettled(page);
  await expect(page.locator("#settled li").filter({ hasText: "Berlin team" })).toHaveCount(0);
  // The unrelated settled decision is still settled, unchanged and not highlighted.
  await expect(formatter).toHaveCount(1);
  expect(await formatter.innerText()).toBe(formatterBefore);
  await expect(formatter).not.toHaveClass(/changed/);

  const s = await stored(page);
  expect(s!.answered["onsite-flight"]).toMatchObject({ initial: "B", final: "B" });
  expect(s!.facts.some((f) => f.text.includes("school drop-off"))).toBe(true);
  // Berlin was re-checked under the new fact and now quotes it.
  expect(s!.cards["berlin-sync"].fact_quoted).toContain("No commitments before 8:30am");
  expect(s!.changes["berlin-sync"]).toContain("No commitments before 8:30am");
});
