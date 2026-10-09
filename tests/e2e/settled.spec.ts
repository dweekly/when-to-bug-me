// Decisions made for you (build plan, item 4): undo reopens a settled decision as a quick check-in,
// and the two marks are stored separately.
import { expect, test } from "@playwright/test";
import { freshPage, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("Undo on branch cleanup brings it back as a quick check-in", async ({ page }) => {
  const settled = page.locator("#settled li").filter({ hasText: "Delete 41 feature branches" });
  await settled.getByRole("button", { name: "Undo" }).click();

  await expect(settled).toHaveCount(0);
  const item = page.locator("#agenda").getByRole("button", { name: /Delete 41 feature branches/ });
  await expect(item).toBeVisible();
  await expect(item.locator(".r").first()).toContainText("Quick check-in");
  await expect(item.locator(".change-note")).toContainText("You undid");
  const s = (await stored(page))!;
  expect(s.reopened).toContain("branch-cleanup");
  expect(s.record.some((r) => r.kind === "undo" && r.id === "branch-cleanup")).toBe(true);
});

test("'You should have asked me' and 'Right to decide, wrong call' are stored as separate marks", async ({ page }) => {
  const row = () => page.locator("#settled li").filter({ hasText: "Run the formatter across the SDK repo" });
  await row().getByRole("button", { name: "You should have asked me" }).click();
  await expect(row().getByRole("button", { name: "You should have asked me" })).toHaveAttribute("aria-pressed", "true");
  await expect(row().getByRole("button", { name: "Right to decide, wrong call" })).toHaveAttribute("aria-pressed", "false");
  await row().getByRole("button", { name: "Right to decide, wrong call" }).click();
  await expect(row().getByRole("button", { name: "Right to decide, wrong call" })).toHaveAttribute("aria-pressed", "true");

  const s = (await stored(page))!;
  expect([...s.settledMarks["formatter-run"]].sort()).toEqual(["should_have_asked", "wrong_call"]);
  const marks = s.record.filter((r) => r.kind === "mark" && r.id === "formatter-run");
  expect(marks.map((m) => m.mark)).toEqual(["should_have_asked", "wrong_call"]);
  expect(marks.every((m) => m.on === true)).toBe(true);
  // Marks on one settled decision do not touch another.
  expect(s.settledMarks["branch-cleanup"]).toBeUndefined();
});
