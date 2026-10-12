// Decisions made for you (build plan, item 4): undo reopens a settled decision as a quick check-in on
// home's agenda, and the two marks are stored separately.
import { expect, test } from "@playwright/test";
import { agendaItem, freshPage, goHome, goSettled, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
  await goSettled(page);
});

test("Undo on branch cleanup brings it back as a quick check-in", async ({ page }) => {
  const settled = page.locator("#settled li").filter({ hasText: "Delete 41 feature branches" });
  await settled.getByRole("button", { name: "Undo" }).click();

  await expect(settled).toHaveCount(0);
  await goHome(page);
  const item = agendaItem(page, "Delete 41 feature branches");
  await expect(item).toBeVisible();
  await expect(item.locator(".glyph")).toHaveAttribute("aria-label", "Quick check-in");
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

// Stage 6 (docs/STAGE-6.md, section 3): grouped by kind of work, plain words, the same three icon
// actions on every row, and no rule codes or route glyphs.
test.describe("the grouped list", () => {
  test.beforeEach(async ({ page }) => {
    await freshPage(page);
    await page.goto("/app#/settled");
    await expect(page.locator("#settled")).toBeVisible();
  });

  test("groups start closed, say what they hold once, and give every job the same three actions", async ({ page }) => {
    await expect(page.locator("#settled .dgroup")).toHaveCount(4);
    await expect(page.locator("#settled .dgroup[open]")).toHaveCount(0);
    await expect(page.locator("#settled .dgroup > summary .dtitle")).toHaveText(["Merged branches", "Patch updates", "Formatting and lint", "Flaky tests"]);
    await expect(page.locator(".page > .quiet").first()).toHaveText("31 small jobs, each one undoable and covered by one of your rules.");
    const rows = page.locator("#settled li.drow");
    await expect(rows).toHaveCount(31);
    for (const name of ["Undo", "Ask!", "Disagree"]) await expect(page.locator("#settled .dacts").getByRole("button", { name, includeHidden: true })).toHaveCount(31);
    // No rule codes, no route glyphs, no per-row Why.
    const text = await page.locator("#settled").textContent();
    expect(text).not.toMatch(/\bR\d+\b/);
    expect(text).not.toMatch(/[○◐●]/);
    await expect(page.locator("#settled .why-s")).toHaveCount(0);
  });

  test("a group's rule shows only when asked, in plain words", async ({ page }) => {
    const branches = page.locator('#settled .dgroup[data-work="branches"]');
    await branches.locator("> summary").click();
    const rule = branches.locator(".drule");
    await expect(rule.locator("p")).toBeHidden();
    await rule.locator("summary").click();
    await expect(rule.locator("p")).toContainText("Your rule: “Housekeeping in our own repos");
  });

  test("an opened group stays open when a job in it is marked", async ({ page }) => {
    const updates = page.locator('#settled .dgroup[data-work="updates"]');
    await updates.locator("> summary").click();
    await updates.locator("li.drow").first().getByRole("button", { name: "Disagree" }).click();
    await expect(updates.locator("li.drow").first().getByRole("button", { name: "Disagree" })).toHaveAttribute("aria-pressed", "true");
    await expect(updates).toHaveAttribute("open", "");
  });

  test("labels show on every job's actions at phone width @narrow", async ({ page }, info) => {
    test.skip(!info.project.use.isMobile, "phone and narrow widths only");
    const flaky = page.locator('#settled .dgroup[data-work="flaky-tests"]');
    await flaky.locator("> summary").click();
    for (const label of await flaky.locator(".dlabel").all()) await expect(label).toBeVisible();
    const box = await flaky.locator(".dacts button").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("review fixes", () => {
  test.beforeEach(async ({ page }) => {
    await freshPage(page);
  });

  test("a job with no past-tense line still shows what Bug Me chose", async ({ page }) => {
    // Serve the queue without one card's fast-model lines, as when that call couldn't be evaluated.
    await page.route("**/api/queue", async (route) => {
      const res = await route.fetch();
      const q = await res.json();
      for (const c of q.cards) if (c.id === "formatter-run") delete c.done;
      await route.fulfill({ response: res, json: q });
    });
    await page.goto("/app#/settled");
    await page.reload();
    await expect(page.locator("#settled")).toBeVisible();
    const row = page.locator('#settled li.drow[data-id="formatter-run"]');
    await expect(row.locator(".ddone")).toContainText("Run the formatter across the SDK repo");
    await expect(row.locator(".dpick")).toHaveText(/^ → \S/);
  });

  test("a tour started from the menu begins with every group closed", async ({ page }) => {
    await page.goto("/app#/settled");
    await page.locator('#settled .dgroup[data-work="branches"] > summary').click();
    await expect(page.locator("#settled .dgroup[open]")).toHaveCount(1);
    await page.locator("#bar").getByRole("button", { name: "Tours" }).click();
    await page.locator(".tour-item").filter({ hasText: "What Bug Me decided for you" }).click();
    await expect(page.locator(".driver-popover-title")).toHaveText("Decided for you");
    await expect(page.locator("#settled .dgroup[open]")).toHaveCount(0);
  });
});
