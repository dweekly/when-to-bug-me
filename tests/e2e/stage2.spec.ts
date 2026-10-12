// Stage 2 views (docs/STAGE-2.md, "What the person sees" and "Contracts"): home is an overview with
// nothing to decide on it; focus shows exactly one decision; Start and Next keep the person inside a
// project until its active queue is clear, then pause between projects; "Not now" needs a reason,
// moves the decision to Set aside (kept across reloads, never settled automatically) and Resume brings
// it back with what was said; direct links, unknown ids and Back/Forward behave; nothing scrolls
// sideways at 320px.
//
// The fake model routes the Platform project's six waiting decisions as three decisions and three
// quick check-ins, and favors option A (the agent's pick) on each at 70%, so answering A with no
// reason finishes a card at once: no pushback, no "why?", no proposed guidance.
import { type Page, expect, test } from "@playwright/test";
import { puntInstruction } from "../../src/shared/punt";
import {
  agendaItem,
  editRule,
  freshPage,
  goHome,
  goSettled,
  openDecision,
  option,
  projectGroup,
  stored,
  waitForHome,
  waitForLoad, decide, think } from "./helpers";

/** Platform's waiting (unsettled) decisions in the fixtures. */
const PLATFORM = ["incident-action-items", "onsite-flight"];
const FIRST_NAME = "Jordan";

function focusedId(page: Page): string {
  const m = /#\/d\/([^/]+)$/.exec(page.url());
  return m ? decodeURIComponent(m[1]) : "";
}

/** Answer the card in focus with its first option (the agent's pick), without a reason, and wait for Next. */
async function answerQuickly(page: Page): Promise<void> {
  const now = page.locator("#now");
  await now.locator(".options .opt").first().click();
  await now.locator(".send").click();
  await expect(now.getByRole("button", { name: "Next decision" })).toBeVisible();
}

/** Open "Not now" on the card in focus, pick a kind of reason, give a sentence, and set it aside. */
async function setAside(page: Page, chip: string, reason: string): Promise<void> {
  const now = page.locator("#now");
  await now.getByRole("button", { name: "Not now" }).click();
  await now.getByRole("button", { name: chip }).click();
  await now.locator("#punt-reason").fill(reason);
  await now.getByRole("button", { name: "Set aside" }).click();
}

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test.describe("views", () => {
  test("home shows no decision card; focus shows exactly one", async ({ page }) => {
    await expect(page.locator("#now")).toHaveCount(0);
    await expect(page.locator("article.card")).toHaveCount(0);
    await expect(page.locator("#start")).toBeVisible();
    // The whole queue is on screen, numbered in order, grouped by project; nothing to expand.
    await expect(page.locator("#agenda .project")).toHaveCount(3);
    const items = page.locator("#agenda a.item");
    const n = await items.count();
    expect(n).toBeGreaterThan(0);
    expect(await page.locator("#agenda .num").allInnerTexts()).toEqual(Array.from({ length: n }, (_, i) => String(i + 1)));
    for (const id of PLATFORM) await expect(projectGroup(page, "Platform").locator(`a.item[href="#/d/${id}"]`)).toHaveCount(1);

    await agendaItem(page, "Denver customer onsite").click();
    await expect(page).toHaveURL(/#\/d\/onsite-flight$/);
    await expect(page.locator("#now")).toHaveCount(1);
    await expect(page.locator("article.card")).toHaveCount(1);
    await expect(page.locator("#agenda")).toHaveCount(0);
    await expect(page.locator(".focus-bar")).toContainText("Platform");
  });

  test("one pile is recommended, and its Start opens the first item in the queue", async ({ page }) => {
    await expect(page.locator(".pile.rec")).toHaveCount(1);
    const first = page.locator("#agenda a.item").first();
    const href = (await first.getAttribute("href"))!;
    const text = (await first.locator(".q").innerText()).trim();
    const firstProject = (await page.locator("#agenda .pname").first().innerText()).trim();
    await expect(page.locator("#start-card .eyebrow")).toHaveText(new RegExp(`Start with ${firstProject}`, "i"));
    await expect(page.locator("#start-card .peek li").first()).toHaveText(text);
    await page.locator("#start").click();
    await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`));
    await expect(page.locator("#now-q")).toHaveText(text);
    await expect(page.locator(".focus-bar")).toContainText(new RegExp(firstProject, "i"));
  });

  test("each other pile's Start opens that pile's first item", async ({ page }) => {
    const pile = page.locator('.pile[data-project="platform"]');
    const firstHref = (await projectGroup(page, "Platform").locator("a.item").first().getAttribute("href"))!;
    await pile.getByRole("button", { name: "Start Platform" }).click();
    await expect(page).toHaveURL(new RegExp(`${firstHref.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`));
  });

  test("the bar's nav reaches every view, and Decided for you shows its count", async ({ page }) => {
    const nav = page.locator("#bar nav");
    await expect(nav.getByRole("link", { name: "Decided for you · 31" })).toBeVisible();
    await nav.getByRole("link", { name: /^Decided for you/ }).click();
    await expect(page).toHaveURL(/#\/settled$/);
    await expect(page.locator("#settled > li")).toHaveCount(31);
    await nav.getByRole("link", { name: "Rules" }).click();
    await expect(page).toHaveURL(/#\/rules$/);
    await expect(page.locator("#rules > li")).toHaveCount(12);
    await expect(page.locator("#facts > li").first()).toBeVisible();
    await nav.getByRole("link", { name: "Record" }).click();
    await expect(page).toHaveURL(/#\/record$/);
    await expect(page.locator("#export")).toBeVisible();
    await expect(page.locator("#reset")).toBeVisible();
    await nav.getByRole("link", { name: "Home" }).click();
    await waitForHome(page);
    await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });

  test("/ is the explainer, and its Open the app link reaches Home", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Open the app" }).click();
    await expect(page).toHaveURL(/\/app(#.*)?$/);
    await waitForHome(page);
  });
});

test.describe("navigation", () => {
  test("a direct link opens that decision on a cold load", async ({ page }) => {
    await page.goto("about:blank");
    await page.goto("/app#/d/onsite-flight");
    await waitForLoad(page);
    await expect(page.locator("#now-q")).toContainText("6:05am flight");
  });

  test("a direct link to an unknown id falls back to home", async ({ page }) => {
    await page.goto("about:blank");
    await page.goto("/app#/d/no-such-decision");
    await waitForHome(page);
    await expect(page.locator("#now")).toHaveCount(0);
    // And the same within a loaded page.
    await openDecision(page, "onsite-flight");
    await page.goto("/app#/d/also-not-a-decision");
    await waitForHome(page);
    await expect(page.locator("#now")).toHaveCount(0);
  });

  test("Back and Forward move between home and focus", async ({ page }) => {
    await agendaItem(page, "6:05am flight").click();
    await expect(page.locator("#now-q")).toContainText("6:05am flight");
    await page.goBack();
    await waitForHome(page);
    await expect(page.locator("#now")).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(/#\/d\/onsite-flight$/);
    await expect(page.locator("#now-q")).toContainText("6:05am flight");
  });
});

test.describe("Next", () => {
  test("Next stays within the project, then pauses between projects when it is done", async ({ page }) => {
    await projectGroup(page, "Platform").locator("a.item").first().click();
    const seen: string[] = [];
    for (let i = 0; i < PLATFORM.length; i++) {
      await expect(page.locator("#now-q")).toBeVisible();
      const id = focusedId(page);
      expect(PLATFORM, `step ${i} opened ${id}`).toContain(id);
      expect(seen).not.toContain(id);
      seen.push(id);
      await expect(page.locator(".focus-bar")).toContainText("Platform");
      await answerQuickly(page);
      await page.locator("#now").getByRole("button", { name: "Next decision" }).click();
    }
    expect([...seen].sort()).toEqual([...PLATFORM].sort());

    await expect(page).toHaveURL(/#\/between\/platform$/);
    const between = page.locator(".between");
    await expect(between.getByRole("heading", { level: 1 })).toHaveText("Platform is done.");
    // Launch unblocks the most agents, so it comes first among what is left.
    const nextBtn = between.getByRole("button", { name: "Next: Launch" });
    await expect(nextBtn).toBeVisible();
    await nextBtn.click();
    await expect(page).toHaveURL(/#\/d\/api-rename$/);
    await expect(page.locator(".focus-bar")).toContainText("Launch");

    // Every Platform answer is recorded, and Platform has left home's agenda.
    const s = (await stored(page))!;
    for (const id of PLATFORM) expect(s.answered[id]?.final, id).toBe("A");
    await goHome(page);
    await expect(projectGroup(page, "Platform")).toHaveCount(0);
  });

  test("a set-aside decision does not block a project's end: its active queue is clear", async ({ page }) => {
    await openDecision(page, "onsite-flight");
    await setAside(page, "Not urgent yet", "After the launch date is final, so I know which week the onsite is.");
    for (let i = 0; i < PLATFORM.length - 1; i++) {
      await expect(page.locator("#now-q")).toBeVisible();
      const id = focusedId(page);
      expect(PLATFORM).toContain(id);
      expect(id).not.toBe("onsite-flight");
      await answerQuickly(page);
      await page.locator("#now").getByRole("button", { name: "Next decision" }).click();
    }
    await expect(page).toHaveURL(/#\/between\/platform$/);
    await expect(page.locator(".between h1")).toHaveText("Platform's active queue is clear.");
    await expect(page.locator(".between")).toContainText("1 set aside or waiting for you to finish.");
  });
});

test.describe("Not now", () => {
  test("needs a kind and a real sentence, then sets the decision aside and opens the next one", async ({ page }) => {
    await openDecision(page, "onsite-flight");
    const now = page.locator("#now");
    await now.getByRole("button", { name: "Not now" }).click();
    await expect(now.getByText("What would you need to decide this?")).toBeVisible();
    const chips = now.locator(".punt .chip-btn");
    await expect(chips).toHaveCount(4);
    await expect(chips).toHaveText(["I need more information", "I need someone else's input", "Not urgent yet", "I'm not sure what I think"]);

    // Nothing picked: refused.
    await now.getByRole("button", { name: "Set aside" }).click();
    await expect(now.getByRole("alert")).toHaveText("Pick what you need first.");

    // Each kind asks its own question, which labels the sentence box.
    await now.getByRole("button", { name: "I need more information" }).click();
    await expect(now.getByLabel("What information is missing?")).toBeVisible();
    await now.getByRole("button", { name: "I need someone else's input" }).click();
    await expect(now.getByRole("button", { name: "I need someone else's input" })).toHaveAttribute("aria-pressed", "true");
    await expect(now.getByRole("button", { name: "I need more information" })).toHaveAttribute("aria-pressed", "false");
    const box = now.getByLabel("Whose input, and on what?");
    await expect(box).toHaveAttribute("id", "punt-reason");

    // Too short to act on: refused, with the question repeated.
    await box.fill("Sam");
    await now.getByRole("button", { name: "Set aside" }).click();
    await expect(now.getByRole("alert")).toHaveText("Whose input, and on what?");
    expect((await stored(page))?.punts ?? {}).toEqual({});

    const reason = "Ask Priya whether the Denver team can start at 11 instead of 10.";
    await box.fill(reason);
    await now.getByRole("button", { name: "Set aside" }).click();

    // The next decision in the same project opens.
    await expect(page).not.toHaveURL(/#\/d\/onsite-flight$/);
    await expect(page.locator("#now-q")).toBeVisible();
    expect(PLATFORM).toContain(focusedId(page));
    await expect(page.locator(".focus-bar")).toContainText("Platform");

    // The record keeps the reason and exactly what the agent was told; nothing was answered.
    const s = (await stored(page))!;
    const instruction = puntInstruction("input", reason, FIRST_NAME);
    expect(s.punts["onsite-flight"]).toMatchObject({ kind: "input", reason, instruction });
    const ev = s.record.filter((r) => r.id === "onsite-flight" && r.instruction === instruction);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ reason, instruction, from_phase: "choose" });
    expect(s.answered["onsite-flight"]).toBeUndefined();
    await expect(page.locator("#announce")).toContainText(instruction);

    // Home: gone from the agenda, listed under Set aside with the reason.
    await goHome(page);
    await expect(page.locator('#agenda a.item[href="#/d/onsite-flight"]')).toHaveCount(0);
    const aside = page.locator("#aside");
    await expect(aside.getByRole("heading", { name: "Set aside" })).toBeVisible();
    const item = aside.locator(".aside-item").filter({ hasText: "6:05am flight" });
    await expect(item).toHaveCount(1);
    await expect(item.locator(".aside-reason")).toHaveText(reason);
  });

  test("Cancel returns to the card without setting anything aside", async ({ page }) => {
    await openDecision(page, "onsite-flight");
    const now = page.locator("#now");
    await now.getByRole("button", { name: "Not now" }).click();
    await now.getByRole("button", { name: "Not urgent yet" }).click();
    await now.getByRole("button", { name: "Cancel" }).click();
    await expect(now.locator(".punt")).toHaveCount(0);
    await expect(now.locator(".options .opt").first()).toBeEnabled();
    expect((await stored(page))?.punts ?? {}).toEqual({});
  });

  test("a set-aside decision survives a reload, and Resume brings it back with what was said", async ({ page }) => {
    const reason = "Which customers are on the Denver call, and is the room booked yet?";
    await openDecision(page, "onsite-flight");
    await setAside(page, "I need more information", reason);
    await expect(page).not.toHaveURL(/#\/d\/onsite-flight$/);

    await page.goto("/app#/");
    await page.reload();
    await waitForHome(page);
    const item = page.locator("#aside .aside-item").filter({ hasText: "6:05am flight" });
    await expect(item.locator(".aside-reason")).toHaveText(reason);

    await item.getByRole("button", { name: "Resume" }).click();
    await expect(page).toHaveURL(/#\/d\/onsite-flight$/);
    const resumed = page.locator("#now .resumed");
    await expect(resumed).toContainText(`You set this aside: “${reason}”`);
    await expect(resumed).toContainText("The agent was asked to:");
    await expect(resumed).toContainText("Nothing new has been gathered");
    // It is a live decision again.
    await expect(page.locator("#now").getByRole("button", { name: "Not now" })).toBeVisible();

    const s = (await stored(page))!;
    expect(s.punts["onsite-flight"]).toBeUndefined();
    expect(s.puntHistory["onsite-flight"]).toHaveLength(1);
    expect(s.puntHistory["onsite-flight"][0]).toMatchObject({ kind: "info", reason, instruction: puntInstruction("info", reason, FIRST_NAME) });
    // The resume is recorded after the set-aside.
    expect(s.record.filter((r) => r.id === "onsite-flight" && r.reason === reason)).toHaveLength(2);

    await goHome(page);
    await expect(page.locator("#aside")).toHaveCount(0);
    await expect(page.locator('#agenda a.item[href="#/d/onsite-flight"]')).toHaveCount(1);

    // The history stays with the decision after it is answered.
    await openDecision(page, "onsite-flight");
    await answerQuickly(page);
    expect((await stored(page))!.puntHistory["onsite-flight"]).toHaveLength(1);
  });

  test("is offered at pushback, and not once an answer is final", async ({ page }) => {
    await openDecision(page, "sdk-dependency");
    await think(page, "Because generated validators stay in sync with the OpenAPI spec for free.");
    await decide(page, "Add the library");
    const push = page.locator("#now .followup.push");
    await expect(push).toBeVisible();
    await push.getByRole("button", { name: "Not now" }).click();
    await page.locator("#now").getByRole("button", { name: "I'm not sure what I think" }).click();
    await page.locator("#punt-reason").fill("Whether vendoring a validator is really less work than the dependency.");
    await page.locator("#now").getByRole("button", { name: "Set aside" }).click();
    await expect(page).not.toHaveURL(/#\/d\/sdk-dependency$/);
    let s = (await stored(page))!;
    expect(s.punts["sdk-dependency"]?.kind).toBe("unsure");
    expect(s.record.find((r) => r.id === "sdk-dependency" && typeof r.instruction === "string")).toMatchObject({ from_phase: "pushback" });
    expect(s.answered["sdk-dependency"]).toBeUndefined();

    // Once an answer is final, the follow-up has no Not now.
    await openDecision(page, "onsite-flight");
    await decide(page, "9:40am flight");
    await expect(page.getByText("I'm curious: why?")).toBeVisible();
    await expect(page.locator("#now").getByRole("button", { name: "Not now" })).toHaveCount(0);
    s = (await stored(page))!;
    expect(s.answered["onsite-flight"]?.final).toBe("B");
  });

  test("the record keeps a 'punt' event and a 'resume' event", async ({ page }) => {
    const reason = "Ask Priya whether the Denver team can start at 11 instead of 10.";
    await openDecision(page, "onsite-flight");
    await setAside(page, "I need someone else's input", reason);
    await expect(page).not.toHaveURL(/#\/d\/onsite-flight$/);
    await goHome(page);
    await page.locator("#aside .aside-item").filter({ hasText: "6:05am flight" }).getByRole("button", { name: "Resume" }).click();
    await expect(page).toHaveURL(/#\/d\/onsite-flight$/);
    const s = (await stored(page))!;
    const punts = s.record.filter((r) => r.kind === "punt" && r.id === "onsite-flight");
    expect(punts).toHaveLength(1);
    expect(punts[0]).toMatchObject({ reason, instruction: puntInstruction("input", reason, FIRST_NAME) });
    expect(s.record.filter((r) => r.kind === "resume" && r.id === "onsite-flight")).toHaveLength(1);
  });

  test("a set-aside decision never shows under Decided for you, even after a rule edit would settle it", async ({ page }) => {
    const id = "settings-redesign";
    await openDecision(page, id);
    await setAside(page, "Not urgent yet", "Once the launch is out; the comparison can wait a week.");
    await expect(page).not.toHaveURL(new RegExp(`#/d/${id}$`));

    // R11 rewritten to clear UI layout choices, so a re-check would settle it.
    await editRule(page, "R11", "UI layout choices on a preview branch: just do it.");
    await expect.poll(async () => (await stored(page))!.pending.length).toBe(0);
    const s = (await stored(page))!;
    expect(s.cards[id].route, "the re-check really did say settle").toBe("settle");
    expect(s.punts[id]).toBeDefined();

    await goSettled(page);
    await expect(page.locator("#settled li").filter({ hasText: "Settings page redesign" })).toHaveCount(0);
    await expect(page.locator("#bar nav").getByRole("link", { name: "Decided for you · 31" })).toBeVisible();
    await goHome(page);
    await expect(page.locator("#aside .aside-item").filter({ hasText: "Settings page redesign" })).toHaveCount(1);
    await expect(page.locator(`#agenda a.item[href="#/d/${id}"]`)).toHaveCount(0);
    // A direct link still opens it (as set aside), never redirecting to Decided for you.
    await openDecision(page, id);
    await expect(page).toHaveURL(new RegExp(`#/d/${id}$`));
  });
});

test.describe("narrow layout", () => {
  const NO_HSCROLL = "document.documentElement.scrollWidth <= window.innerWidth";
  const OVERFLOW = "({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })";
  const noHScroll = async (page: Page, where: string) =>
    expect(await page.evaluate(NO_HSCROLL), `${where}: ${JSON.stringify(await page.evaluate(OVERFLOW))}`).toBe(true);

  test("no horizontal scroll on home or in focus @narrow", async ({ page }) => {
    await noHScroll(page, "home");
    await noHScroll(page, "home, agenda expanded");
    for (const id of ["onsite-flight", "berlin-sync", "settings-redesign", "api-rename", "free-tier", "sdk-dependency"]) {
      await openDecision(page, id);
      await noHScroll(page, id);
    }
    await page.locator("#now").getByRole("button", { name: "Not now" }).click();
    await page.locator("#now").getByRole("button", { name: "I need someone else's input" }).click();
    await noHScroll(page, "Not now panel");
  });
});
