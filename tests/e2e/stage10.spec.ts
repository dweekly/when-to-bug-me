// Stage 10 (docs/STAGE-10.md): getting to know Jordan, on the stand-in model. Read, draft (every line
// cites decisions you can open), interview (DEMO REPLY fills Jordan's answers by question id), revise.
import { expect, test } from "@playwright/test";
import { freshPage } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("Home links to onboarding; it reads, drafts with receipts, interviews and revises", async ({ page }) => {
  await page.locator(".welcome-link a").click();
  await expect(page.locator("#step-read .welcome-stats")).toContainText("30 decisions");
  await page.locator("#draft-note").click();
  const lines = page.locator("#step-draft .note-line");
  await expect(lines.first()).toBeVisible();
  await lines.first().locator(".cites").click();
  await expect(page.locator("#step-draft .cites-list li").first()).toBeVisible();
  await page.locator("#start-interview").click();
  const revise = page.locator("#revise-note");
  await expect(revise).toBeDisabled();
  await page.locator("#step-interview .demo-reply").first().click();
  await expect(revise).toBeEnabled();
  await revise.click();
  await expect(page.locator("#step-note .note-line").first()).toBeVisible();
  await expect(page.locator("#step-note .change-changed")).toHaveCount(1);
  await expect(page.locator("#step-note")).toContainText("hand-written note");
  // The draft folds away once there's a revision.
  await expect(page.locator("#step-draft details.draft-was")).toBeVisible();
  // The answers that made it are locked; Change answers drops the revision and unlocks them.
  await expect(page.locator("#step-interview textarea").first()).toHaveAttribute("readonly", "");
  await expect(page.locator("#step-interview .demo-reply")).toHaveCount(0);
  await page.locator("#change-answers").click();
  await expect(page.locator("#revise-note")).toBeEnabled();
  await expect(page.locator("#step-note")).toHaveCount(0);
});

test("Rules points to how a note like Jordan's is drafted", async ({ page }) => {
  await page.goto("/app#/rules");
  await expect(page.locator("#note-source")).toContainText("Written by hand");
  await page.getByRole("link", { name: /drafts a note like this/ }).click();
  await expect(page.locator(".welcome h1")).toHaveText("Getting to know Jordan");
});

test("on a phone, onboarding fits the width @narrow", async ({ page }) => {
  await page.goto("/app#/welcome");
  await page.locator("#draft-note").click();
  await page.locator("#start-interview").click();
  await page.locator("#step-interview .demo-reply").first().click();
  await page.locator("#revise-note").click();
  await expect(page.locator("#step-note")).toBeVisible();
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
});

test("the hosted owner page refuses onboarding on your own history: it runs on the runner", async ({ request }) => {
  const r = await request.post("/api/me/onboarding", { headers: { authorization: `Bearer ${process.env.BUGME_E2E_LIVE_TOKEN}` }, data: { history: [] } });
  expect(r.status()).toBe(404);
  expect((await r.json()).error).toContain("runner");
});

test("a revision in flight can't be sent twice", async ({ page }) => {
  await page.goto("/app#/welcome");
  await page.locator("#draft-note").click();
  await page.locator("#start-interview").click();
  await page.locator("#step-interview .demo-reply").first().click();
  let posts = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/onboarding/revise", async (route) => {
    posts++;
    await held;
    await route.continue();
  });
  await page.locator("#revise-note").click();
  await page.locator("#step-interview textarea").nth(1).fill("Typing while it's out.");
  await expect(page.locator("#revise-note")).toBeDisabled();
  release();
  await expect(page.locator("#step-note")).toBeVisible();
  expect(posts).toBe(1);
});
