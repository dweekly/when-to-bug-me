// Regression tests for the lane 4 review: answers stay bound to the card that started them, drafts
// survive re-renders, late reasons reach the record, over-long guidance is refused, and re-routed
// cards survive a reload.
import { expect, test } from "@playwright/test";
import { freshPage, openFromAgenda, option, stored, waitForLoad } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

async function flightNo(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "answer the 6:05am flight question" }).click();
  await option(page, "9:40am flight").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
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
  await page.getByRole("button", { name: "answer the 6:05am flight question" }).click();
  await option(page, "9:40am flight").click();
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  // While the flight's check is held, open another decision and pick an option there.
  await openFromAgenda(page, "File the five action items");
  await option(page, "File all five as drafted").click();
  release();
  await expect.poll(async () => (await stored(page))?.answered["onsite-flight"]?.final).toBe("B");
  const s = await stored(page);
  expect(s?.answered["incident-action-items"]).toBeUndefined();
  // The card in front of the person is still the one they opened, with their selection intact.
  await expect(page.locator("#now-q")).toContainText("File the five action items");
  await expect(option(page, "File all five as drafted")).toHaveAttribute("aria-pressed", "true");
});

test("a why draft survives a re-render caused by marking a settled decision", async ({ page }) => {
  await flightNo(page);
  await page.getByLabel("Why did you choose that?").fill("School drop-off until 8:30");
  await page.locator("#settled li").first().getByRole("button", { name: "Right to decide, wrong call" }).click();
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
  await page.getByRole("button", { name: /Edit rule R12/ }).click();
  await page.getByLabel("Rule R12").fill("y".repeat(241));
  await page.getByRole("button", { name: "Save and re-route" }).click();
  await expect(page.locator("#rules [role=alert]")).toContainText("under 240 characters");
  expect((await stored(page))?.rules?.find((r) => r.id === "R12")?.text ?? "").not.toContain("yyyy");
  await expect(page.getByLabel("Rule R12")).toHaveValue("y".repeat(241));
});

test("a re-routed card whose route did not change survives a reload", async ({ page }) => {
  // The API rename is first on the agenda, so it is already the card in front of the person.
  await expect(page.locator("#now-q")).toContainText("user_id");
  await option(page, "Keep user_id").click();
  await page.locator("#basis").fill("Renames break every integrator; keep existing field names in anything public.");
  await page.locator("#now").getByRole("button", { name: "Decide", exact: true }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  const quoted = async () =>
    (JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v1')")) as string).cards["webhook-rename"].fact_quoted as string);
  await expect.poll(quoted).toContain("keep existing field names");
  // Remove the presentation note, so only the "re-evaluated" record can keep this card across a reload.
  await page.evaluate(`(() => { const s = JSON.parse(localStorage.getItem('bugme.state.v1')); delete s.changes['webhook-rename']; localStorage.setItem('bugme.state.v1', JSON.stringify(s)); })()`);
  await page.reload();
  await waitForLoad(page);
  expect(await quoted()).toContain("keep existing field names");
});

test("a failed re-check is shown on a settled decision and announced", async ({ page }) => {
  await page.route("**/api/route", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "no API key configured", unavailable: true }) }),
  );
  await page.getByRole("button", { name: /Edit rule R8/ }).click();
  await page.getByLabel("Rule R8").fill("Ask me before accepting any recurring meeting.");
  await page.getByRole("button", { name: "Save and re-route" }).click();
  const berlin = page.locator("#settled li").filter({ hasText: "Berlin team" });
  await expect(berlin.locator(".change-note")).toContainText("Couldn't re-check");
  await expect(page.locator("#announce")).toContainText("couldn't be re-checked");
});

test("a newer edit takes over an unfinished re-route pass instead of abandoning it", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = true;
  await page.route("**/api/route", async (route) => {
    if (held) await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: /Edit rule R12/ }).click();
  await page.getByLabel("Rule R12").fill("Travel: never book flights that leave before 8am.");
  await page.getByRole("button", { name: "Save and re-route" }).click();
  // The first pass is now waiting on held requests; a second edit supersedes it.
  await page.getByRole("button", { name: /Edit rule R4/ }).click();
  await page.getByLabel("Rule R4").fill("Anything customers will see comes to me before it goes out.");
  await page.getByRole("button", { name: "Save and re-route" }).click();
  held = false;
  release();
  const state = async () => JSON.parse((await page.evaluate("localStorage.getItem('bugme.state.v1')")) as string);
  await expect.poll(async () => (await state()).pending.length, { timeout: 20_000 }).toBe(0);
  const s = await state();
  const total = Object.keys(s.cards).length;
  expect(Object.keys(s.evaluated).length).toBe(total);
  // The flight was re-checked under the new travel rule, not left on its old route.
  expect(s.cards["onsite-flight"].rule_quoted).toContain("never book flights");
});
