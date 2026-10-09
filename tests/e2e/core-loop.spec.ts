// The core loop (build plan, "Intent"): answer the 6:05am flight question against Bug Me's hidden
// guess, get asked "I'm curious: why?", keep the reason as a standing fact, and watch the Berlin sync
// re-route because of it while an unrelated settled decision stays put.
import { expect, test } from "@playwright/test";
import { freshPage, option, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("flight -> why -> kept fact -> Berlin sync re-routes, formatter run unchanged", async ({ page }) => {
  const formatter = page.locator("#settled li").filter({ hasText: "Run the formatter across the SDK repo" });
  await expect(formatter).toHaveCount(1);
  const formatterBefore = await formatter.innerText();
  // Berlin sync starts settled, so it is not in the agenda yet.
  await expect(page.locator("#settled li").filter({ hasText: "Berlin team" })).toHaveCount(1);
  await expect(page.locator("#agenda").getByText("Berlin team")).toHaveCount(0);

  await page.getByRole("button", { name: "answer the 6:05am flight question" }).click();
  await expect(page.locator("#now-q")).toContainText("6:05am flight");
  await option(page, "9:40am flight").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();

  await expect(page.getByText("I'm curious: why?")).toBeVisible();
  await expect(page.getByText("hidden until now")).toHaveCount(0);

  await page.getByLabel("Why did you choose that?").fill("I do school drop-off before 8:30, so no early-morning flights for me.");
  await page.getByRole("button", { name: "Tell Bug Me" }).click();

  const guessLine = page.locator("#now").getByText("Bug Me's guess, hidden until now:");
  await expect(guessLine).toBeVisible();
  await expect(page.locator("#now")).toContainText("You went the other way.");

  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.locator("#facts")).toContainText("No commitments before 8:30am");

  const berlin = page.locator("#agenda").getByRole("button", { name: /Berlin team/ });
  await expect(berlin).toBeVisible();
  const note = berlin.locator(".change-note");
  await expect(note).toContainText("Moved from");
  await expect(note).toContainText("Quick check-in");
  await expect(note).toContainText("No commitments before 8:30am");
  await expect(page.locator("#settled li").filter({ hasText: "Berlin team" })).toHaveCount(0);

  // The unrelated settled decision is still settled, unchanged and not highlighted.
  await expect(formatter).toHaveCount(1);
  expect(await formatter.innerText()).toBe(formatterBefore);
  await expect(formatter).not.toHaveClass(/changed/);

  const s = await stored(page);
  expect(s!.answered["onsite-flight"]).toMatchObject({ initial: "B", final: "B" });
  expect(s!.facts.some((f) => f.text.includes("school drop-off"))).toBe(true);
  expect(s!.record.some((r) => r.kind === "rerouted" && r.id === "berlin-sync")).toBe(true);
});
