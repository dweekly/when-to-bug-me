// Reflection prompts (docs/STAGE-10.md, 10c) on the stand-in server. The fake model routes Launch's five
// waiting questions as four decisions and one quick check (about 13 estimated minutes), so finishing
// Launch first is a demanding stretch: the change-of-project screen suggests a break, and, being the
// first change of project, asks "Were those worth your time?". A tap lands in the record and its export,
// once, however the screen is revisited; #/review draws from the record; nothing scrolls sideways at 320px.
import { type Page, expect, test } from "@playwright/test";
import { MINUTES_PER_CHECK_IN, MINUTES_PER_DECISION } from "../../src/shared/constants";
import { freshPage, goRecord, stored, toDecision } from "./helpers";

const LAUNCH = ["api-rename", "webhook-rename", "settings-redesign", "sdk-dependency", "free-tier"];
const LAUNCH_MINUTES = 4 * MINUTES_PER_DECISION + MINUTES_PER_CHECK_IN;

/** Answer the card in focus with its first option and no reason, taking Bug Me's pushback where it
 *  pushes back and keeping no guidance, and wait for Next. */
async function answerQuickly(page: Page): Promise<void> {
  const now = page.locator("#now");
  await now.locator(".options .opt").first().click();
  await now.locator(".send").click();
  await toDecision(page);
  const dont = now.getByRole("button", { name: "Don't keep" });
  const change = now.getByRole("button", { name: /^Change to / });
  const nextBtn = now.getByRole("button", { name: "Next decision" });
  for (let i = 0; i < 4; i++) {
    await expect(dont.or(change).or(nextBtn).first()).toBeVisible();
    if (await nextBtn.count()) return;
    await (await dont.count() ? dont : change).click();
  }
  await expect(nextBtn).toBeVisible();
}

/** Begin the suggested pile (Launch) and answer every question in it, ending on the change of project. */
async function finishLaunch(page: Page): Promise<void> {
  await page.locator("#start").click();
  for (let i = 0; i < LAUNCH.length; i++) {
    await expect(page.locator(".focus-bar")).toContainText("Launch");
    await answerQuickly(page);
    await page.locator("#now").getByRole("button", { name: "Next decision" }).click();
  }
  await expect(page).toHaveURL(/#\/between\/launch$/);
}

const NO_HSCROLL = "document.documentElement.scrollWidth <= window.innerWidth";
const OVERFLOW = "({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })";
async function noHScroll(page: Page, where: string): Promise<void> {
  expect(await page.evaluate(NO_HSCROLL), `${where}: ${JSON.stringify(await page.evaluate(OVERFLOW))}`).toBe(true);
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await freshPage(page);
  await page.evaluate("localStorage.removeItem('bugme.dispatch.v1')");
});

test("after a demanding stretch, the change of project suggests a break, once, and it can be dismissed", async ({ page }) => {
  await finishLaunch(page);
  const line = page.locator("#break-line");
  await expect(line).toContainText(`~${LAUNCH_MINUTES} min of real decisions`);
  await expect(line).toContainText("Stand up before Billing?");
  await expect(line.locator("abbr.est")).toHaveText("est.");
  // Never blocking: Next is right there.
  await expect(page.locator(".between").getByRole("button", { name: "Next: Billing" })).toBeEnabled();
  await page.screenshot({ path: `test-results/shots/reflection-between-${test.info().project.name}.png`, fullPage: true });
  await line.getByRole("button", { name: "Dismiss" }).click();
  await expect(line).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".between h1")).toHaveText("Launch is done.");
  await expect(page.locator("#break-line")).toHaveCount(0);
  const s = (await stored(page))! as unknown as { transitions: { n: number; breakOffered: boolean; breakDismissed: boolean }[]; record: { kind: string }[] };
  expect(s.transitions).toHaveLength(1);
  expect(s.transitions[0]).toMatchObject({ n: 1, breakOffered: true, breakDismissed: true });
  expect(s.record.filter((r) => r.kind === "break_dismissed")).toHaveLength(1);

  // Billing is short: its change of project offers no break, and (second change) no feedback.
  await page.locator(".between").getByRole("button", { name: "Next: Billing" }).click();
  for (let i = 0; i < 2; i++) {
    await expect(page.locator(".focus-bar")).toContainText("Billing");
    await answerQuickly(page);
    await page.locator("#now").getByRole("button", { name: "Next decision" }).click();
  }
  await expect(page).toHaveURL(/#\/between\/billing$/);
  await expect(page.locator(".between h1")).toHaveText("Billing is done.");
  await expect(page.locator("#break-line")).toHaveCount(0);
  await expect(page.locator("#worth")).toHaveCount(0);
});

test("a feedback tap lands in the record once, survives reload and Back, and is in the export", async ({ page }) => {
  await finishLaunch(page);
  const worth = page.locator("#worth");
  await expect(worth).toContainText("Were those 5 worth your time?");
  await expect(worth.locator(".chip-btn")).toHaveText(["●All worth it", "◐Some should have been settled", "○None needed me"]);
  await worth.getByRole("button", { name: "Some should have been settled" }).click();
  await expect(page.locator("#worth")).toHaveText("◐ Noted.");
  await page.screenshot({ path: `test-results/shots/reflection-noted-${test.info().project.name}.png`, fullPage: true });

  // Reload, Back and Forward show the same change of project: no new prompt, no second event.
  await page.reload();
  await expect(page.locator("#worth")).toHaveText("◐ Noted.");
  await page.goBack();
  await page.goForward();
  await expect(page.locator("#worth")).toHaveText("◐ Noted.");
  const s = (await stored(page))!;
  const fb = s.record.filter((r) => r.kind === "feedback");
  expect(fb).toHaveLength(1);
  expect(fb[0]).toMatchObject({ transition: "t1", project: "launch", choice: "some" });
  expect([...(fb[0].covered as string[])].sort()).toEqual([...LAUNCH].sort());
  expect(s.record.filter((r) => r.kind === "transition")).toHaveLength(1);

  await goRecord(page);
  const download = page.waitForEvent("download");
  await page.locator("#export").click();
  const file = await (await download).path();
  const exported = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")) as { record: { kind: string; choice?: string }[] };
  expect(exported.record.filter((r) => r.kind === "feedback").map((r) => r.choice)).toEqual(["some"]);
});

test("the feedback ask can be dismissed, and stays dismissed", async ({ page }) => {
  await finishLaunch(page);
  await page.locator("#worth").getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("#worth")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".between h1")).toBeVisible();
  await expect(page.locator("#worth")).toHaveCount(0);
  const s = (await stored(page))!;
  expect(s.record.filter((r) => r.kind === "feedback")).toHaveLength(0);
  expect(s.record.filter((r) => r.kind === "feedback_dismissed")).toHaveLength(1);
});

test("#/review draws the morning from the record: time by project against the stated order, settled or asked, Dispatch", async ({ page }) => {
  await finishLaunch(page);
  await page.locator("#worth").getByRole("button", { name: "All worth it" }).click();
  // A Dispatch demo brief, copied: its synthetic report enters the record.
  await page.goto("/app#/dispatch");
  await page.locator('.demo-chip[data-example="usage-demo"]').click();
  await page.locator("#draft-brief").click();
  await expect(page.locator("#brief")).toBeVisible();
  await page.locator("#copy-command").click();
  await expect(page.locator(".brief-outcome")).toContainText("done");

  // Linked from the record in one line.
  await goRecord(page);
  await page.getByRole("link", { name: "Weekly review sketch →" }).click();
  await expect(page).toHaveURL(/#\/review$/);
  const review = page.locator(".review");
  await expect(review.locator(".rv-eyebrow")).toHaveText("A sketch of the weekly review, from this morning's record");
  await expect(review.locator(".rv-bars li .rv-name")).toHaveText(["Billing", "Launch", "Platform"]);
  await expect(review.locator(".rv-bars li .rv-rank")).toHaveText(["#1", "#2", "#3"]);
  await expect(review.locator(".rv-finding")).toHaveText("Most time went to Launch, your #2.");
  await expect(review.locator('.rv-bars li[data-project="launch"] .rv-min')).toHaveText(`~${LAUNCH_MINUTES}m`);
  await expect(review.locator('.rv-bars li[data-project="launch"] .rv-dots')).toHaveText("●●●●◐");
  await expect(review.locator(".rv-legend")).toContainText("5 asked you: ● 4 · ◐ 1");
  await expect(review.locator(".rv-legend")).toContainText("settled for you now");
  await expect(review.locator("#rv-worth")).toContainText("● 1");
  const brief = review.locator(".rv-briefs li");
  await expect(brief).toHaveCount(1);
  await expect(brief.locator(".rv-dfacts")).toContainText("38m of ~30m · cost not reported");
  await expect(brief.locator(".meta-chip")).toHaveText("synthetic");
  await expect(brief.locator(".rv-took")).toHaveClass(/over/);
  await page.screenshot({ path: `test-results/shots/reflection-review-${test.info().project.name}.png`, fullPage: true });
});

test("an empty morning's review says so", async ({ page }) => {
  await page.goto("/app#/review");
  await expect(page.locator(".rv-finding")).toHaveText("Nothing answered yet this morning.");
  await expect(page.locator("#rv-dispatch")).toContainText("No briefs sent yet.");
});

test("the change of project and #/review fit 320px without sideways scroll @narrow", async ({ page }) => {
  await finishLaunch(page);
  await expect(page.locator("#break-line")).toBeVisible();
  await expect(page.locator("#worth")).toBeVisible();
  await noHScroll(page, "between, with both asks");
  await page.goto("/app#/dispatch");
  await page.locator('.demo-chip[data-example="usage-demo"]').click();
  await page.locator("#draft-brief").click();
  await page.locator("#copy-command").click();
  await expect(page.locator(".brief-outcome")).toContainText("done");
  await page.goto("/app#/review");
  await expect(page.locator(".rv-briefs li")).toHaveCount(1);
  await noHScroll(page, "review");
  await page.screenshot({ path: "test-results/shots/reflection-review-narrow.png", fullPage: true });
});

test("the review's styles stay on the review: the decision card keeps its own type", async ({ page }) => {
  await page.goto("/app#/d/api-rename");
  await expect(page.locator("#now #now-q")).toBeVisible();
  const style = (await page.evaluate("(() => { const s = getComputedStyle(document.getElementById('now')); return { font: s.fontSize, family: s.fontFamily, radius: s.borderRadius }; })()")) as { font: string; family: string; radius: string };
  expect(style.font).toBe("16px");
  expect(style.family).not.toMatch(/Mono/);
  expect(style.radius).not.toBe("999px");
});

test("after starting the morning over, copying a demo brief again brings its synthetic report back to the review", async ({ page }) => {
  await page.goto("/app#/dispatch");
  await page.locator('.demo-chip[data-example="usage-demo"]').click();
  await page.locator("#draft-brief").click();
  await page.locator("#copy-command").click();
  await expect(page.locator(".brief-outcome")).toContainText("done");
  await goRecord(page);
  await page.locator("#reset").click();
  await page.goto("/app#/dispatch");
  await page.locator(".briefs li a").first().click();
  await page.locator("#copy-command").click();
  await page.goto("/app#/review");
  const facts = page.locator(".rv-briefs li .rv-dfacts");
  await expect(facts).toContainText("38m of ~30m · cost not reported");
  await expect(facts.locator(".meta-chip")).toHaveText("synthetic");
  const s = (await stored(page))!;
  expect(s.record.filter((r) => r.kind === "dispatch_report")).toHaveLength(1);
});

test("a demo Copy the clipboard refuses sends nothing: no synthetic report, nothing finished in the review", async ({ page }) => {
  await page.goto("/app#/dispatch");
  await page.evaluate("navigator.clipboard.writeText = () => Promise.reject(new Error('denied'))");
  await page.locator('.demo-chip[data-example="usage-demo"]').click();
  await page.locator("#draft-brief").click();
  await page.locator("#copy-command").click();
  await expect(page.locator("#brief .brief-actions .think-msg")).toContainText("Couldn't copy");
  await expect(page.locator(".brief-outcome")).toHaveCount(0);
  const s = (await stored(page))!;
  expect(s.record.filter((r) => r.kind === "dispatch_report")).toHaveLength(0);
  await page.goto("/app#/review");
  await expect(page.locator("#rv-dispatch")).not.toContainText("38m");
});

test("after starting the morning over, a refused Copy doesn't bring the old synthetic report back", async ({ page }) => {
  await page.goto("/app#/dispatch");
  await page.locator('.demo-chip[data-example="usage-demo"]').click();
  await page.locator("#draft-brief").click();
  await page.locator("#copy-command").click();
  await expect(page.locator(".brief-outcome")).toContainText("done");
  await goRecord(page);
  await page.locator("#reset").click();
  await page.goto("/app#/dispatch");
  await page.evaluate("navigator.clipboard.writeText = () => Promise.reject(new Error('denied'))");
  await page.locator(".briefs li a").first().click();
  await page.locator("#copy-command").click();
  await expect(page.locator("#brief .brief-actions .think-msg")).toContainText("Couldn't copy");
  const s = (await stored(page))!;
  expect(s.record.filter((r) => r.kind === "dispatch_report")).toHaveLength(0);
});
