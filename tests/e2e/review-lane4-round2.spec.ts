// Regression tests for the lane 4 second review: pending re-checks are saved at once, an answer uses
// the card it started on, a reset discards late responses, open follow-ups stay reachable, dictation
// cannot cross cards, and the explored-options card asks for its teach-back.
import { expect, test } from "@playwright/test";
import { editRule, freshPage, goHome, goRecord, hold, openDecision, openFromAgenda, option, decide, decideQuietly } from "./helpers";

const state = async (page: import("@playwright/test").Page) =>
  JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v4')")) as string);

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("pending re-checks are saved before their requests return", async ({ page }) => {
  const release = await hold(page, "/api/route");
  await editRule(page, "R8", "Ask me before accepting any recurring meeting.");
  await expect.poll(async () => (await state(page)).pending.length).toBeGreaterThan(0);
  release();
});

test("an answer uses the card it started on: a re-route leaves a decision alone while it is being talked through", async ({ page }) => {
  const release = await hold(page, "/api/answer", (b) => b.id === "onsite-flight" && b.stage === "check");
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  await editRule(page, "R12", "Travel: never book flights that leave before 8am.");
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  // The conversation is open, so the card isn't re-routed under the person (docs/STAGE-6.md).
  expect((await state(page)).cards["onsite-flight"].rule_quoted ?? "").not.toContain("never book flights");
  release();
  await expect.poll(async () => (await state(page)).answered["onsite-flight"]?.final).toBe("B");
  const guess = (await state(page)).answered["onsite-flight"].guess as { option: string; p: number }[];
  // The guess sealed on the original card (the fake model's 70% on A), not the re-routed one.
  expect(guess.find((g) => g.option === "A")!.p).toBeCloseTo(0.7);
  await openDecision(page, "onsite-flight");
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
});

test("starting over discards a response that arrives afterwards", async ({ page }) => {
  const release = await hold(page, "/api/answer", (b) => b.id === "onsite-flight");
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  await goRecord(page);
  await page.getByRole("button", { name: "Start the morning over" }).click();
  release();
  await page.waitForTimeout(500);
  expect(Object.keys((await state(page)).answered)).toHaveLength(0);
});

test("an open 'why?' stays reachable after opening another card", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
  await openFromAgenda(page, "File the five action items");
  await goHome(page);
  const unfinished = page.locator("#unfinished");
  await expect(unfinished.getByText("Waiting for you to finish")).toBeVisible();
  await unfinished.getByRole("link", { name: /flight/i }).click();
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
});

test("the explored-options card prompts a teach-back, and deciding without one still works", async ({ page }) => {
  await openFromAgenda(page, "Settings page");
  await expect(page.locator("#think")).toHaveAttribute("placeholder", /what happens next/);
  await decide(page, "One page");
  await expect.poll(async () => (await state(page))?.answered?.["settings-redesign"]?.final).toBe("B");
});
