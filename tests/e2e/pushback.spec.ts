// Pushback (build plan, lifecycle step 4): choosing an option that contradicts a standing fact, with no
// reason given, brings the fact back, quoted, and the person can change the answer; both choices are
// recorded. A reason already given is taken as the exception's explanation: no pushback (docs/STAGE-11.md).
import { expect, test } from "@playwright/test";
import { freshPage, openFromAgenda, option, stored, decide } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("adding the schema library with no reason is pushed back on with F1, and 'Change to' records the other option", async ({ page }) => {
  await openFromAgenda(page, "schema-validation library");
  await decide(page, "Add the library");

  const push = page.locator("#now .followup.push");
  await expect(push).toBeVisible();
  await expect(push).toContainText("No new runtime dependencies");
  await push.getByRole("button", { name: /^Change to/ }).click();

  await expect(page.locator("#now .reveal-line")).toBeVisible();
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

test("a reason given with the answer is not argued with: no pushback, the answer stands", async ({ page }) => {
  await openFromAgenda(page, "schema-validation library");
  await decide(page, "Add the library", "Because generated validators stay in sync with the OpenAPI spec for free.");
  await expect(page.locator("#now .reveal-line")).toBeVisible();
  await expect(page.locator("#now .followup.push")).toHaveCount(0);
  const s = (await stored(page))!;
  expect(s.answered["sdk-dependency"]).toMatchObject({ initial: "A", final: "A", pushback: null });
  expect(s.record.some((r) => r.kind === "pushback")).toBe(false);
});
