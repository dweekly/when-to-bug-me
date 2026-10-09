// Regression tests for the lane 4 second review: pending re-checks are saved at once, an answer uses
// the card it started on, a reset discards late responses, open follow-ups stay reachable, dictation
// cannot cross cards, and the explored-options card asks for its teach-back.
import { expect, test } from "@playwright/test";
import { freshPage, openFromAgenda, option } from "./helpers";

const state = async (page: import("@playwright/test").Page) =>
  JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v1')")) as string);

function hold(page: import("@playwright/test").Page, path: string, match: (b: Record<string, unknown>) => boolean = () => true) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = true;
  void page.route(`**${path}`, async (route) => {
    if (held && match(route.request().postDataJSON() ?? {})) await gate;
    await route.continue();
  });
  return () => {
    held = false;
    release();
  };
}

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("pending re-checks are saved before their requests return", async ({ page }) => {
  const release = hold(page, "/api/route");
  await page.getByRole("button", { name: /Edit rule R8/ }).click();
  await page.getByLabel("Rule R8").fill("Ask me before accepting any recurring meeting.");
  await page.getByRole("button", { name: "Save and re-route" }).click();
  await expect.poll(async () => (await state(page)).pending.length).toBeGreaterThan(0);
  release();
});

test("an answer uses the card it started on, even if a re-route replaces it mid-answer", async ({ page }) => {
  const release = hold(page, "/api/answer", (b) => b.id === "onsite-flight" && b.stage === "check");
  await page.getByRole("button", { name: "answer the 6:05am flight question" }).click();
  await option(page, "9:40am flight").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  await page.getByRole("button", { name: /Edit rule R12/ }).click();
  await page.getByLabel("Rule R12").fill("Travel: never book flights that leave before 8am.");
  await page.getByRole("button", { name: "Save and re-route" }).click();
  await expect.poll(async () => (await state(page)).cards["onsite-flight"].rule_quoted).toContain("never book flights");
  release();
  await expect.poll(async () => (await state(page)).answered["onsite-flight"]?.final).toBe("B");
  const guess = (await state(page)).answered["onsite-flight"].guess as { option: string; p: number }[];
  // The guess sealed on the original card (the fake model's 70% on A), not the re-routed one.
  expect(guess.find((g) => g.option === "A")!.p).toBeCloseTo(0.7);
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
});

test("starting over discards a response that arrives afterwards", async ({ page }) => {
  const release = hold(page, "/api/answer", (b) => b.id === "onsite-flight");
  await page.getByRole("button", { name: "answer the 6:05am flight question" }).click();
  await option(page, "9:40am flight").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  await page.getByRole("button", { name: "Start the morning over" }).click();
  release();
  await page.waitForTimeout(500);
  expect(Object.keys((await state(page)).answered)).toHaveLength(0);
});

test("an open 'why?' stays reachable after opening another card", async ({ page }) => {
  await page.getByRole("button", { name: "answer the 6:05am flight question" }).click();
  await option(page, "9:40am flight").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
  await openFromAgenda(page, "File the five action items");
  await expect(page.getByText("Waiting for you to finish")).toBeVisible();
  await page.locator("#agenda").getByRole("button", { name: /flight/i }).first().click();
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
});

test("dictation stops when its card is replaced and never writes into another answer", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRec {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (globalThis as unknown as { __rec: FakeRec }).__rec = this;
      }
      stop() {
        this.onend?.();
      }
    }
    (globalThis as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRec;
  });
  await page.reload();
  await expect(page.locator("#now-q")).toContainText("user_id");
  await option(page, "Keep user_id").click();
  await page.getByRole("button", { name: "Answer by voice" }).click();
  await openFromAgenda(page, "Settings page");
  await page.evaluate("window.__rec.onresult({ results: [[{ transcript: 'renames break integrators' }]] })");
  await option(page, "Tabs").click();
  await expect(page.locator("#basis")).toHaveValue("");
});

test("the explored-options card asks for its teach-back even as a quick check-in", async ({ page }) => {
  await openFromAgenda(page, "Settings page");
  await option(page, "One page").click();
  await expect(page.getByText("In a sentence: what happens next if you choose One page?")).toBeVisible();
  const decide = page.locator("#now").getByRole("button", { name: "Decide", exact: true });
  await expect(decide).toBeDisabled();
  await page.locator("#basis").fill("Everything is on one page, so people scroll to API keys.");
  await expect(decide).toBeEnabled();
});
