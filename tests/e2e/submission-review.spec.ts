// Regressions from the submission review (issue #62), on the stand-in model: failed routing stays
// visible (#55), deciding without Bug Me's reading when no model can reply (#51), a failed "Huh?"
// replaced by new words (#58), guidance retry (#54), the reveal's wording (#56 is in stage6f.spec.ts),
// the card's source badge (#57), review totals (#52), Dispatch not stealing navigation (#53), the list
// of decisions (#59), the reset guard (#60), the reason count (#61) and the build id (#49).
import { type Page, expect, test } from "@playwright/test";
import { decideQuietly, editRule, freshPage, goRecord, openDecision, reply, stored } from "./helpers";

const unavailable = (error = "no API key configured; only recorded answers are available") => ({ status: 503, contentType: "application/json", body: JSON.stringify({ error, unavailable: true }) });

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

/** Serve the real queue with some cards replaced by the Worker's "unavailable" shape. */
async function failRoutes(page: Page, which: (id: string, i: number) => boolean): Promise<string[]> {
  const failed: string[] = [];
  await page.route("**/api/queue", async (route) => {
    const res = await route.fetch();
    const q = (await res.json()) as { cards: { id: string }[] };
    q.cards = q.cards.map((c, i) => (which(c.id, i) ? (failed.push(c.id), { id: c.id, unavailable: "the live model call failed" }) : c));
    await route.fulfill({ response: res, json: q });
  });
  await page.evaluate("localStorage.clear()");
  await page.reload();
  await expect(page.locator("#overnight")).toBeVisible();
  return failed;
}

test("#55: a question that couldn't be routed stays listed with a retry, and is never 'All clear'", async ({ page }) => {
  const failed = await failRoutes(page, (id) => id === "api-rename");
  await expect(page.locator("#overnight")).toContainText("1 couldn't be sorted");
  await expect(page.locator("#unrouted .items li")).toHaveCount(1);
  await expect(page.locator("#unrouted")).toContainText("the live model call failed");
  // Try again routes it for real (the stand-in answers), and it joins the queue.
  await page.unroute("**/api/queue");
  await page.locator("#retry-routes").click();
  await expect(page.locator("#unrouted")).toHaveCount(0);
  await expect(page.locator("#overnight")).not.toContainText("couldn't be sorted");
  expect((await stored(page))!.cards[failed[0]].route).toBeTruthy();
});

test("#55: every route failing is not an empty, successful morning", async ({ page }) => {
  await failRoutes(page, () => true);
  await expect(page.locator("#hello")).not.toHaveText("All clear.");
  await expect(page.locator("#overnight")).toContainText("40 couldn't be sorted");
  await expect(page.locator(".all-clear")).toHaveCount(0);
  await expect(page.locator("#unrouted .items li")).toHaveCount(40);
  // The card itself says so, with its own retry.
  await page.locator("#unrouted .items a").first().click();
  await expect(page.locator("#now .retry-route")).toBeVisible();
});

test("#57: the card says where its routing came from before anything is pressed", async ({ page }) => {
  await openDecision(page, "api-rename");
  await expect(page.locator("#now .meta .src-badge")).toBeVisible();
  await expect(page.locator("#now .meta .src-badge")).toHaveText(/live Claude|cached Claude|recorded Claude run|code stand-in/);
});

test("#51: when no model can reply, the person can still decide, and their words go down whole", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.route("**/api/converse", (route) => route.fulfill(unavailable()));
  await page.locator("#think").fill("Keep user_id, but note account_id in the docs.");
  await page.locator("#now .send").click();
  await expect(page.locator("#now .unread")).toBeVisible();
  await expect(page.locator("#now .unread")).toContainText("Bug Me can't reply to this here");
  await expect(page.locator("#now .think-msg")).not.toContainText("Send again to retry");
  await page.unroute("**/api/converse");
  await page.locator("#now .unread .decide-unread", { hasText: "Keep" }).click();
  await expect(page.locator("#now .reveal-line")).toBeVisible();
  const s = (await stored(page))!;
  expect(s.answered["api-rename"].final).toBe("B");
  expect(s.answered["api-rename"].send_down).toContain("words, as said: “Keep user_id, but note account_id in the docs.”");
  expect(s.record.filter((r) => r.kind === "decided_unread")).toHaveLength(1);
});

test("#58: a failed Huh? is replaced by new words, and the draft kept through it still retries it", async ({ page }) => {
  await openDecision(page, "reconciliation-path");
  await page.route("**/api/converse", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "down for a moment" }) }));
  await page.locator("#now .huh-row .huh").click();
  await expect(page.locator("#now .think-msg")).toContainText("Bug Me couldn't reply just now");
  await page.unroute("**/api/converse");
  await page.locator("#think").fill("Leave past invoices alone.");
  await expect(page.locator("#now .send")).toHaveText("Send");
  await page.locator("#now .send").click();
  await reply(page);
  // The Huh? that never got its answer is gone; the words went in its place.
  await expect(page.locator("#now .turns .huh-turn")).toHaveCount(0);
  await expect(page.locator("#now .turns li.mine")).toHaveCount(1);
  await expect(page.locator("#now .turns li.mine")).toContainText("Leave past invoices alone.");
});

test("#54: a failed guidance proposal can be tried again, without answering twice", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  await page.route("**/api/fact", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "down for a moment" }) }));
  await page.locator("#why").fill("School drop-off is at 8; I can't make a 6am flight.");
  await page.locator("#now .followup .primary").click();
  await expect(page.locator("#now .followup")).toContainText("Couldn't turn that into guidance");
  await page.unroute("**/api/fact");
  await page.locator("#now .retry-guidance").click();
  await expect(page.locator("#fact-text")).toBeVisible();
  const s = (await stored(page))!;
  expect(s.record.filter((r) => r.kind === "answer" && r.id === "onsite-flight")).toHaveLength(1);
  // #61: one reason, given after the answer, counts once.
  await expect(page.locator("#voice-glow")).toHaveAttribute("title", /\b1 (real )?reason/);
});

test("#54: a reload while guidance was out leaves a retry", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  // Never answered: the page reloads with the request still out.
  await page.route("**/api/fact", () => undefined);
  await page.locator("#why").fill("School drop-off is at 8.");
  await page.locator("#now .followup .primary").click();
  await expect(page.locator("#now .followup")).toContainText("Turning that into guidance");
  // Still stalled through the reload: unrouting first could let the held request through.
  await page.reload();
  await expect(page.locator("#now .retry-guidance")).toBeVisible();
  await page.unroute("**/api/fact");
  await page.locator("#now .retry-guidance").click();
  await expect(page.locator("#fact-text")).toBeVisible();
});

test("#52: the review accounts for every question once, set-asides included", async ({ page }) => {
  await openDecision(page, "berlin-sync");
  await page.locator("#now .skip-q").click();
  await page.locator(".chip-btn").nth(1).click();
  await page.locator("#punt-reason").fill("Ask whether 9:30 works.");
  await page.locator("#now .punt .primary").click();
  await expect.poll(async () => Object.keys((await stored(page))!.punts)).toEqual(["berlin-sync"]);
  await page.goto("/app#/review");
  const cells = page.locator("#rv-split .rv-cell");
  await expect(cells).toHaveCount(40);
  await expect(page.locator("#rv-split .rv-cell.aside")).toHaveCount(1);
  await expect(page.locator("#rv-split .rv-legend")).toContainText("1 ◇ set aside by you");
});

test("#53: a brief that finishes after the person left doesn't pull them back", async ({ page }) => {
  await page.goto("/app#/dispatch");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/dispatch", async (route) => {
    await gate;
    await route.continue();
  });
  await page.locator("#dispatch-task").fill("Add a usage dashboard for the SDK team.");
  await page.locator("#draft-brief").click();
  await page.locator("#bar nav").getByRole("link", { name: /^Home$/ }).click();
  await expect(page.locator("#overnight")).toBeVisible();
  release();
  await expect(page.locator("#announce")).toContainText("It's waiting in Dispatch", { timeout: 15_000 });
  expect(new URL(page.url()).hash).toBe("#/");
});

test("#59 #63 #49: Your decisions lists what you decided, opens each, and names the build", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  await page.locator("#now .followup .linkish", { hasText: "Skip" }).click();
  await page.locator("#now .followup .primary", { hasText: "Next decision" }).click();
  await goRecord(page);
  await expect(page.locator("#view h1")).toHaveText("Your decisions");
  await expect(page.locator("#decided-list .items li")).toHaveCount(1);
  await expect(page.locator("#decided-list")).toContainText("9:40am flight");
  await expect(page.locator(".build-id")).toHaveText(/^Build [0-9a-f]{7}/);
  await page.locator("#decided-list .items a").click();
  await expect(page.locator("#now")).toContainText("You decided:");
});

test("#60: starting the morning over asks first, and Keep my morning keeps it", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  await goRecord(page);
  await page.locator("#reset").click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Start the morning over?");
  await dlg.getByRole("button", { name: "Keep my morning" }).click();
  expect(Object.keys((await stored(page))!.answered)).toEqual(["onsite-flight"]);
  await page.locator("#reset").click();
  await page.getByRole("dialog").getByRole("button", { name: "Start over" }).click();
  await expect.poll(async () => Object.keys((await stored(page))!.answered)).toEqual([]);
});

test("#64: a job Bug Me decided opens to what it decided and why", async ({ page }) => {
  await page.goto("/app#/settled");
  await page.locator("#settled .dgroup > summary").first().click();
  const row = page.locator("#settled .drow").first();
  await row.locator(".dwhat > summary").click();
  const detail = row.locator(".ddetail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("The agent asked:");
  await expect(detail).toContainText("Bug Me chose:");
  await expect(detail).toContainText("Its reasoning:");
  await expect(detail).toContainText(/Decided by (live Claude|cached Claude|recorded Claude run|code stand-in)\./);
  // Undo and the marks are still there beside it.
  await expect(row.locator(".dundo")).toBeVisible();
});

test("#51: if recording an unread answer fails, the words typed after the notice are kept for the next try", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.route("**/api/converse", (route) => route.fulfill(unavailable()));
  await page.locator("#think").fill("Keep user_id.");
  await page.locator("#now .send").click();
  await expect(page.locator("#now .unread")).toBeVisible();
  await page.locator("#think").fill("Do not deploy before Friday.");
  let failOnce = true;
  await page.route("**/api/answer", (route) => {
    if (failOnce) {
      failOnce = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "down for a moment" }) });
    }
    return route.continue();
  });
  await page.locator("#now .unread .decide-unread", { hasText: "Keep" }).click();
  await expect(page.locator("#now .unread")).toBeVisible();
  await expect(page.locator("#think")).toHaveValue("Do not deploy before Friday.");
  await page.locator("#now .unread .decide-unread", { hasText: "Keep" }).click();
  await expect(page.locator("#now .reveal-line")).toBeVisible();
  const s = (await stored(page))!;
  expect(s.answered["api-rename"].send_down).toContain("“Keep user_id. Do not deploy before Friday.”");
});

test("#55: a routing retry that comes back after a rule edit doesn't overwrite the newer route", async ({ page }) => {
  await failRoutes(page, (id) => id === "formatter-run");
  await page.unroute("**/api/queue");
  // Hold only the retry's request; the re-route the rule edit starts goes through.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route("**/api/route", async (route) => {
    const body = route.request().postDataJSON() as { id?: string };
    if (!held && body.id === "formatter-run") {
      held = true;
      await gate;
    }
    await route.continue();
  });
  await page.locator("#retry-routes").click();
  await expect.poll(() => held).toBe(true);
  await editRule(page, "R2", "Housekeeping in our own repos (formatting, lint fixes, dependency bumps, deleting branches): always ask me first.");
  await expect.poll(async () => (await stored(page))!.cards["formatter-run"].route, { timeout: 15_000 }).toBeTruthy();
  const newer = (await stored(page))!.cards["formatter-run"].route;
  release();
  await page.waitForTimeout(1000);
  expect((await stored(page))!.cards["formatter-run"].route).toBe(newer);
});
