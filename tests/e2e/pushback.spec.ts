// Pushback (build plan, lifecycle step 4): choosing an option that contradicts a standing fact brings
// the fact back, quoted, and the person can change the answer; both choices are recorded.
import { expect, test } from "@playwright/test";
import { freshPage, openFromAgenda, option, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("adding the schema library is pushed back on with F1, and 'Change to' records the other option", async ({ page }) => {
  await openFromAgenda(page, "schema-validation library");
  await option(page, "Add the library").click();
  await page.getByLabel("Why? Say it or type it.").fill("Generated validators stay in sync with the OpenAPI spec for free.");
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();

  const push = page.locator("#now .followup.push");
  await expect(push).toBeVisible();
  await expect(push).toContainText("No new runtime dependencies");
  await push.getByRole("button", { name: /^Change to/ }).click();

  await expect(page.locator("#now")).toContainText("Bug Me's guess, hidden until now:");
  await expect
    .poll(async () => (await stored(page))?.answered["sdk-dependency"]?.final, { message: "final answer stored" })
    .toBe("B");
  const s = (await stored(page))!;
  expect(s.answered["sdk-dependency"].initial).toBe("A");
  expect(s.answered["sdk-dependency"].pushback).toContain("No new runtime dependencies");
  const answer = s.record.find((r) => r.kind === "answer" && r.id === "sdk-dependency")!;
  expect(answer).toMatchObject({ initial: "A", final: "B", pushback_outcome: "changed" });
  expect(s.record.some((r) => r.kind === "pushback" && r.id === "sdk-dependency")).toBe(true);
});
