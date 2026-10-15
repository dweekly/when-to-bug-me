// Stage 6f (docs/STAGE-6F.md): the card in Jordan's words. No agent's pick before deciding; after it, the
// reveal, and a nudge when the answer went against the agent or a confident guess with no reason given.
// One Huh? above the box, DEMO REPLY beside the microphone, a header without the synthetic pill, and a
// phone thread with one firefly and full-width words. On the fake-model server titles carry no plain
// labels, so the options keep the agent's; the recorded run's labels are checked in tours-plain.spec.ts.
import { type Page, expect, test } from "@playwright/test";
import { decideQuietly, freshPage, hold, openDecision, reply } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) <= 560;

test("the agent's pick isn't on the card; after deciding against it, the reveal names it and Bug Me asks why", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await expect(page.locator("#now .agent-pick")).toHaveCount(0);
  await expect(page.locator("#now")).not.toContainText("the agent's pick");
  await decideQuietly(page, "9:40am flight");
  await expect(page.locator("#now .reveal-line")).toHaveText("The agent recommended 6:05am flight, and I expected you to choose it too.");
  await expect(page.locator("#now .why-lead")).toHaveText("What made you go against the agent?");
  // The why box offers Jordan's recorded reason the same way: DEMO REPLY, beside the microphone.
  await page.locator("#now .basis-row .demo-reply").click();
  await expect(page.locator("#why")).toHaveValue(/school drop-off/);
  await expect(page.locator("#now")).not.toContainText("Use Jordan's recorded reason");
});

test("going with the agent and Bug Me's guess: the reveal says so, and there's no nudge", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await decideQuietly(page, "File all five as drafted");
  // The agent recommended it and Bug Me expected it: said once, as two different things.
  await expect(page.locator("#now .reveal-line")).toHaveText("The agent recommended this one, and I expected you to choose it too.");
  await expect(page.locator("#now .why-lead")).toHaveCount(0);
});

test("DEMO REPLY sits in the box and fills it with Jordan's scripted words; it's off while a turn is out", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  const demo = page.locator("#now .composer .demo-reply");
  await expect(demo).toHaveText("DEMO REPLY");
  await expect(page.locator("#now .think-actions")).not.toContainText("Use Jordan's words");
  await demo.click();
  await expect(page.locator("#think")).toHaveValue("Let's take the 9:40.");
  const release = await hold(page, "/api/converse");
  await page.locator("#now .send").click();
  await expect(demo).toBeDisabled();
  release();
  await reply(page);
  await expect(demo).toBeEnabled();
});

test("DEMO REPLY is offered with live Claude on too: the scripted words replay the recording", async ({ page }) => {
  await page.route("**/api/queue", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), mode: "live", live_available: true } });
  });
  await openDecision(page, "onsite-flight");
  await expect(page.locator("#now .composer .demo-reply")).toBeVisible();
});

test("the header has no synthetic pill, and the tours are called Demos", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await expect(page.locator("#bar .synthetic")).toHaveCount(0);
  await expect(page.locator("#bar .tours-btn")).toHaveText("Demos");
});

test("on a phone: one firefly, Bug Me's words use the width, and the views scroll to a gutter after Demos @narrow", async ({ page }) => {
  test.skip(!phone(page), "phone widths only");
  await openDecision(page, "reconciliation-path");
  await page.locator("#now .huh-row .huh").click();
  await reply(page);
  const bug = page.locator("#now .turns li.bug.explain");
  await expect(bug.locator(".bug-face")).toBeHidden();
  const [para, thread] = [await bug.locator("p").boundingBox(), await page.locator("#now .thread").boundingBox()];
  expect(para!.width / thread!.width).toBeGreaterThan(0.8);
  // The source label sits under the words, not beside them.
  const src = await bug.locator(".turn-src").boundingBox();
  expect(src!.y).toBeGreaterThanOrEqual(para!.y + para!.height - 1);
  // The views row, scrolled all the way, leaves the page's gutter after its last item.
  const gap = (await page.evaluate(
    `(() => { const nav = document.querySelector("#bar nav"); nav.scrollLeft = nav.scrollWidth; return window.innerWidth - nav.querySelector(".tours-btn").getBoundingClientRect().right; })()`,
  )) as number;
  expect(gap).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")).toBeLessThanOrEqual(0);
  // The corner firefly scrolls away with the header instead of floating over the thread.
  await bug.scrollIntoViewIfNeeded();
  const fly = await page.locator("#voice").boundingBox();
  expect(fly!.y + fly!.height).toBeLessThanOrEqual(0);
});

test("on a phone, the after-decision note has no firefly of its own", async ({ page }) => {
  test.skip(!phone(page), "phone widths only");
  await openDecision(page, "onsite-flight");
  await decideQuietly(page, "9:40am flight");
  // Wait for the settled note (the nudge): an element read mid-render has no computed style.
  await expect(page.locator("#now .why-lead")).toBeVisible();
  const before = await page.evaluate(`getComputedStyle(document.querySelector("#now .thread ~ .followup"), "::before").display`);
  expect(before).toBe("none");
});
