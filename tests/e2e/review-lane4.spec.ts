// Regression tests for the lane 4 review: answers stay bound to the card that started them, drafts
// survive re-renders, late reasons reach the record, over-long guidance is refused, and re-routed
// cards survive a reload.
import { expect, test } from "@playwright/test";
import { editRule, freshPage, goRules, goSettled, openDecision, openFromAgenda, option, stored, waitForLoad, decide, think } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

async function flightNo(page: import("@playwright/test").Page): Promise<void> {
  await openDecision(page, "onsite-flight");
  await decide(page, "9:40am flight");
  await expect(page.getByText("I'm curious: why?")).toBeVisible();
}

test("an answer in flight stays with its own card when another card is opened", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/answer", async (route) => {
    const body = route.request().postDataJSON() as { id: string; stage: string };
    if (body.id === "onsite-flight" && body.stage === "check") await gate;
    await route.continue();
  });
  await openDecision(page, "onsite-flight");
  await decide(page, "9:40am flight");
  // While the flight's check is held, open another decision and answer it too (clicking decides).
  await openFromAgenda(page, "File the five action items");
  await decide(page, "File all five as drafted");
  release();
  await expect.poll(async () => (await stored(page))?.answered["onsite-flight"]?.final).toBe("B");
  // Each answer stays with its own card: the held flight answer never lands on the other decision.
  await expect.poll(async () => (await stored(page))?.answered["incident-action-items"]?.final).toBe("A");
  await expect(page.locator("#now-q")).toContainText("File the five action items");
});

test("a why draft survives leaving the card to mark a settled decision", async ({ page }) => {
  await flightNo(page);
  await page.getByLabel("Why did you choose that?").fill("School drop-off until 8:30");
  await goSettled(page);
  await page.locator("#settled li").first().getByRole("button", { name: "Right to decide, wrong call" }).click();
  await expect(page.locator("#settled li").first().getByRole("button", { name: "Right to decide, wrong call" })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(page.getByLabel("Why did you choose that?")).toHaveValue("School drop-off until 8:30");
});

test("a reason given at the why prompt is in the exported record", async ({ page }) => {
  await flightNo(page);
  await page.getByLabel("Why did you choose that?").fill("I do school drop-off before 8:30.");
  await page.getByRole("button", { name: "Tell Bug Me" }).click();
  await expect(page.getByRole("button", { name: "Keep it" })).toBeVisible();
  const s = await stored(page);
  const ev = s!.record.filter((r) => r.kind === "answer" && r.id === "onsite-flight").pop()!;
  expect(ev.basis).toBe("I do school drop-off before 8:30.");
  expect(s!.record.some((r) => r.kind === "reason" && r.id === "onsite-flight")).toBe(true);
});

test("over-long guidance is refused and nothing is saved", async ({ page }) => {
  await flightNo(page);
  await page.getByLabel("Why did you choose that?").fill("I do school drop-off before 8:30.");
  await page.getByRole("button", { name: "Tell Bug Me" }).click();
  const before = (await stored(page))!.facts.length;
  await page.getByLabel("Proposed guidance (you can edit it)").fill("x".repeat(241));
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.locator("#now [role=alert]")).toContainText("under 240 characters");
  expect((await stored(page))!.facts.length).toBe(before);
  await expect(page.getByLabel("Proposed guidance (you can edit it)")).toHaveValue("x".repeat(241));
});

test("an over-long rule edit is refused and the draft stays open", async ({ page }) => {
  await goRules(page);
  await page.getByRole("button", { name: /Edit rule R12/ }).click();
  await page.getByLabel("Rule R12").fill("y".repeat(241));
  await page.getByRole("button", { name: "Save and re-route" }).click();
  await expect(page.locator("#rules [role=alert]")).toContainText("under 240 characters");
  expect((await stored(page))?.rules?.find((r) => r.id === "R12")?.text ?? "").not.toContain("yyyy");
  await expect(page.getByLabel("Rule R12")).toHaveValue("y".repeat(241));
});

test("a re-routed card whose route did not change survives a reload", async ({ page }) => {
  // The API rename is first on the agenda, so Start opens it.
  await page.locator("#start").click();
  await expect(page.locator("#now-q")).toContainText("user_id");
  await think(page, "Keep user_id because renames break every integrator; keep existing field names in anything public.");
  await decide(page, "Keep user_id");
  await page.getByRole("button", { name: "Keep it" }).click();
  const quoted = async () =>
    (JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v2')")) as string).cards["webhook-rename"].fact_quoted as string);
  await expect.poll(quoted).toContain("keep existing field names");
  // Remove the presentation note, so only the "re-evaluated" record can keep this card across a reload.
  await page.evaluate(`(() => { const s = JSON.parse(localStorage.getItem('bugme.state.v2')); delete s.changes['webhook-rename']; localStorage.setItem('bugme.state.v2', JSON.stringify(s)); })()`);
  await page.reload();
  await waitForLoad(page);
  expect(await quoted()).toContain("keep existing field names");
});

test("a failed re-check is shown on a settled decision and announced", async ({ page }) => {
  await page.route("**/api/route", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "no API key configured", unavailable: true }) }),
  );
  await editRule(page, "R8", "Ask me before accepting any recurring meeting.");
  await expect(page.locator("#announce")).toContainText("couldn't be re-checked");
  await goSettled(page);
  const formatter = page.locator("#settled li").filter({ hasText: "Run the formatter across the SDK repo" });
  await expect(formatter.locator(".change-note")).toContainText("Couldn't re-check");
});

test("a newer edit takes over an unfinished re-route pass instead of abandoning it", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = true;
  await page.route("**/api/route", async (route) => {
    if (held) await gate;
    await route.continue();
  });
  await editRule(page, "R12", "Travel: never book flights that leave before 8am.");
  // The first pass is now waiting on held requests; a second edit supersedes it.
  await editRule(page, "R4", "Anything customers will see comes to me before it goes out.");
  held = false;
  release();
  const state = async () => JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v2')")) as string);
  await expect.poll(async () => (await state()).pending.length, { timeout: 20_000 }).toBe(0);
  const s = await state();
  const total = Object.keys(s.cards).length;
  expect(Object.keys(s.evaluated).length).toBe(total);
  // The flight was re-checked under the new travel rule, not left on its old route.
  expect(s.cards["onsite-flight"].rule_quoted).toContain("never book flights");
});
