// Regression tests for the stage 2 lane reviews (app side): answered and set-aside decisions opened
// by link are shown read-only, Resume keeps a decision with the person, and Skip to content keeps
// the current view.
import { expect, test } from "@playwright/test";
import { editRule, freshPage, openDecision, option, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("Back onto an answered decision shows it read-only; it cannot be answered again", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  await page.getByRole("button", { name: "Next decision" }).click();
  await page.goBack();
  await expect(page.locator("#now")).toContainText("You decided:");
  await expect(page.locator("#now .opt")).toHaveCount(0);
  const s = await stored(page);
  expect(s!.record.filter((r) => r.kind === "answer" && r.id === "incident-action-items")).toHaveLength(1);
});

async function setAside(page: import("@playwright/test").Page, id: string) {
  await openDecision(page, id);
  await page.locator("#now").getByRole("button", { name: "Not now" }).click();
  await page.locator(".chip-btn").nth(0).click();
  await page.locator("#punt-reason").fill("The full list of the five items and their owners first.");
  await page.locator("#now .punt .primary").click();
}

test("a set-aside decision opened by link needs Resume before it can be answered", async ({ page }) => {
  await setAside(page, "incident-action-items");
  await page.goto("/app#/d/incident-action-items");
  await expect(page.locator("#now")).toContainText("Set aside:");
  await expect(page.locator("#now .opt")).toHaveCount(0);
  await page.locator("#now").getByRole("button", { name: "Resume" }).click();
  await expect(page.locator("#now .opt")).toHaveCount(2);
});

test("resuming a set-aside decision that a rule change made settle-able brings it back to the person", async ({ page }) => {
  await editRule(page, "R2", "Housekeeping in our own repos: ask me.");
  await expect.poll(async () => (await stored(page))!.pending?.length ?? 0).toBe(0);
  await setAside(page, "formatter-run");
  await editRule(page, "R2", "Housekeeping in our own repos (formatting, lint fixes, patch-level dependency bumps, deleting merged branches): just do it.");
  await expect.poll(async () => (await stored(page))!.pending?.length ?? 0).toBe(0);
  await page.goto("/app#/");
  await page.locator("#aside").getByRole("button", { name: "Resume" }).click();
  await expect(page).toHaveURL(/#\/d\/formatter-run$/);
  await expect(page.locator("#now .opt")).toHaveCount(2);
});

test("Skip to content keeps the current view", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.keyboard.press("Tab");
  await page.locator(".skip").press("Enter");
  await expect(page).toHaveURL(/#\/d\/api-rename$/);
  await expect(page.locator("#now .opt")).toHaveCount(2);
});

test("dictation stops when Not now opens or closes, so speech never lands in the wrong box", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRec {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (globalThis as unknown as { __recs: FakeRec[] }).__recs ??= [];
        (globalThis as unknown as { __recs: FakeRec[] }).__recs.push(this);
      }
      stop() {
        (this as unknown as { stopped: boolean }).stopped = true;
        this.onend?.();
      }
    }
    (globalThis as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRec;
  });
  await page.reload();
  await openDecision(page, "api-rename");
  await option(page, "Keep user_id").click();
  await page.locator("#now").getByRole("button", { name: "Answer by voice" }).click();
  await page.locator("#now").getByRole("button", { name: "Not now" }).click();
  expect(await page.evaluate("window.__recs.at(-1).stopped === true")).toBe(true);
  await page.getByRole("button", { name: "I need more information" }).click();
  await page.locator("#now").getByRole("button", { name: "Answer by voice" }).click();
  await page.locator("#now").getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate("window.__recs.length === 2 && window.__recs[1].stopped === true")).toBe(true);
});
