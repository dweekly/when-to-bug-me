// Stage 6's decision conversation (docs/STAGE-6.md): Bug Me's opening is the card; the person talks
// it through in turns; Bug Me asks at most a light question, reads the decision back, and the button
// is the decision itself. On the fake-model server, whose stand-in (fakeConverse) asks "Why that
// one?" after a bare pick, reads back once there is a reason, a condition or "just do it", answers a
// question with "I don't know; I'll ask the agent", closes on a lone "yes" after a read-back, and reads
// "Neither, …" as a course of the person's own and "wrong question" as a rejection.
import { type Page, expect, test } from "@playwright/test";
import { STORE_KEY, freshPage, goRecord, hold, openDecision, option, reply, say, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

const answered = async (page: Page, id: string) => (await stored(page))?.answered?.[id] as Record<string, unknown> | undefined;
const turns = (page: Page) => page.locator("#now .turns > li");
const sendBtn = (page: Page) => page.locator("#now .send");

test("the card is Bug Me's opening: briefing, why it's yours, more context, the question, the options; Send waits for words or a pick", async ({ page }) => {
  await openDecision(page, "api-rename");
  const before = (a: string, b: string) => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(a)}).compareDocumentPosition(document.querySelector(${JSON.stringify(b)})) & Node.DOCUMENT_POSITION_FOLLOWING)`);
  expect(await before("#now .briefing", "#now details.more")).toBe(true);
  expect(await before("#now details.more", "#now-q")).toBe(true);
  expect(await before("#now .options", "#now .thread")).toBe(true);
  const [a, b] = await page.locator("#now .opt").all();
  const [ba, bb] = [await a.boundingBox(), await b.boundingBox()];
  if ((page.viewportSize()?.width ?? 0) > 700) expect(Math.abs(ba!.y - bb!.y)).toBeLessThan(2);
  await expect(page.locator("#now .opt .snippet").first()).toContainText('"account_id"');
  await expect(sendBtn(page)).toHaveText("Send");
  await expect(sendBtn(page)).toBeDisabled();
  await expect(turns(page)).toHaveCount(0);
});

test("a bare click earns one light question, and nothing is answered yet", async ({ page }) => {
  const answers: string[] = [];
  page.on("request", (r) => r.url().includes("/api/answer") && answers.push(r.url()));
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await expect(option(page, "File all five as drafted")).toHaveAttribute("aria-pressed", "true");
  await sendBtn(page).click();
  await reply(page);
  await expect(turns(page).nth(0)).toContainText("A · File all five as drafted");
  await expect(turns(page).nth(1)).toContainText("Why that one?");
  await expect(sendBtn(page)).toHaveText("Send");
  expect(answers).toHaveLength(0);
  expect(await answered(page, "incident-action-items")).toBeUndefined();
});

test("a reason gets the read-back; the button is the decision, and pressing it answers with the reason and the thread", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await sendBtn(page).click();
  await reply(page);
  await say(page, "Because the volunteers already agreed in the meeting.");
  await expect(turns(page).last()).toHaveClass(/readback/);
  await expect(turns(page).last()).toContainText("So: file all five as drafted. Right?");
  await expect(sendBtn(page)).toHaveText("File all five as drafted");
  await sendBtn(page).click();
  await expect.poll(async () => (await answered(page, "incident-action-items"))?.final).toBe("A");
  const a = (await answered(page, "incident-action-items"))!;
  expect(a.basis).toBe("Because the volunteers already agreed in the meeting.");
  expect(a.outcome).toBe("option");
  expect((a.thread as { turns: unknown[] }).turns).toHaveLength(4);
  // The conversation already asked, so the backstop "I'm curious: why?" never does.
  await expect(page.getByText("I'm curious: why?")).toHaveCount(0);
});

test("what Bug Me heard is marked in the person's words, and conditions go down verbatim", async ({ page }) => {
  await openDecision(page, "api-rename");
  await say(page, "Keep user_id, because integrators parse v1 responses. As long as the docs explain why.");
  const mine = turns(page).first();
  await expect(mine.locator("mark.m-choice")).toHaveText("Keep user_id");
  await expect(mine.locator("mark.m-why")).toContainText("because integrators parse v1 responses");
  await expect(mine.locator("mark.m-but")).toContainText("As long as the docs explain why");
  await expect(turns(page).last()).toContainText("as long as the docs explain why");
  await sendBtn(page).click();
  await expect.poll(async () => (await answered(page, "api-rename"))?.final).toBe("B");
  const a = (await answered(page, "api-rename"))!;
  expect(a.conditions).toBe("As long as the docs explain why.");
  expect(a.send_down).toContain("Conditions from Jordan: As long as the docs explain why.");
});

test("a typed yes after the read-back decides; a yes that adds a condition is read back again", async ({ page }) => {
  await openDecision(page, "api-rename");
  await say(page, "Keep user_id, because integrators parse v1 responses.");
  await say(page, "Yes, as long as the docs explain why.");
  await expect(turns(page).last()).toHaveClass(/readback/);
  await expect(turns(page).last()).toContainText("as long as the docs explain why");
  expect(await answered(page, "api-rename")).toBeUndefined();
  await page.locator("#think").fill("Yes");
  await page.locator("#think").press("Enter");
  await expect.poll(async () => (await answered(page, "api-rename"))?.final).toBe("B");
});

test("a course of the person's own is recorded as something else, in their words", async ({ page }) => {
  await openDecision(page, "free-tier");
  await say(page, "Neither, run a two-week trial at 2,500 first.");
  await expect(turns(page).last()).toContainText("So: not either option.");
  await expect(sendBtn(page)).toHaveText("Do something else");
  await sendBtn(page).click();
  await expect.poll(async () => (await answered(page, "free-tier"))?.final).toBe("other");
  const a = (await answered(page, "free-tier"))!;
  expect(a.outcome).toBe("other");
  expect(a.other).toContain("run a two-week trial at 2,500 first");
  expect(a.send_down).toContain("chose neither option");
});

test("the question itself can be rejected, and the agent is told so", async ({ page }) => {
  await openDecision(page, "api-rename");
  await say(page, "Wrong question. Why are we renaming anything in v2 at all?");
  await expect(turns(page).last()).toContainText("rejecting the question");
  await sendBtn(page).click();
  await expect.poll(async () => (await answered(page, "api-rename"))?.final).toBe("rejected");
  expect((await answered(page, "api-rename"))!.send_down).toContain("rejected the question as asked");
  await expect(page.locator("#now .senddown")).toContainText("rejected the question");
});

test("a question the agent's material can't answer goes back to the agent, and the decision waits", async ({ page }) => {
  await openDecision(page, "api-rename");
  await say(page, "How many integrations read that field directly?");
  await expect(turns(page).last()).toContainText("I'll ask the agent");
  await say(page, "Just do it.");
  await expect(turns(page).last()).toContainText("I'll ask the agent: How many integrations read that field directly");
  await expect(sendBtn(page)).toHaveText("Ask the agent");
  await sendBtn(page).click();
  await expect.poll(async () => (await stored(page))?.punts?.["api-rename"]?.kind).toBe("info");
});

test("\"just do it\" stops the questions, and the why backstop stays quiet", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await option(page, "9:40am flight").click();
  await sendBtn(page).click();
  await reply(page);
  await say(page, "Just do it.");
  await expect(sendBtn(page)).toHaveText("9:40am flight");
  await sendBtn(page).click();
  await expect(page.locator("#now")).toContainText("Bug Me's guess, hidden until now:");
  await expect(page.getByText("I'm curious: why?")).toHaveCount(0);
});

test("Send is claimed once: a double click sends one turn", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => r.url().includes("/api/converse") && calls.push(r.url()));
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await sendBtn(page).dblclick();
  await reply(page);
  expect(calls).toHaveLength(1);
  await expect(turns(page)).toHaveCount(2);
});

test("Skip is off while a turn is out, and the typing dots show", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  const release = await hold(page, "/api/converse");
  await page.locator("#think").fill("Show me the list first.");
  await sendBtn(page).click();
  await expect(page.locator("#now .turns li.typing")).toHaveCount(1);
  await expect(page.locator("#now .skip-q")).toBeDisabled();
  release();
  await reply(page);
  await expect(page.locator("#now .skip-q")).toBeEnabled();
});

test("a reload keeps the thread; a turn that never got a reply offers Send again", async ({ page }) => {
  await openDecision(page, "api-rename");
  await say(page, "Keep user_id, because integrators parse v1 responses.");
  await page.route("**/api/converse", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "down for a moment" }) }));
  await page.locator("#think").fill("Actually, rename it.");
  await sendBtn(page).click();
  await expect(page.locator("#now .think-msg")).toContainText("Bug Me couldn't reply just now");
  await page.unroute("**/api/converse");
  await page.reload();
  await expect(turns(page)).toHaveCount(3);
  await expect(sendBtn(page)).toHaveText("Send again");
  await sendBtn(page).click();
  await reply(page);
  await expect(turns(page)).toHaveCount(4);
});

test("an answered decision re-opens with its conversation, read-only", async ({ page }) => {
  await openDecision(page, "api-rename");
  await say(page, "Keep user_id, because integrators parse v1 responses.");
  await sendBtn(page).click();
  await expect.poll(async () => (await answered(page, "api-rename"))?.final).toBe("B");
  await page.getByRole("button", { name: "Don't keep" }).click();
  await page.getByRole("button", { name: "Next decision" }).click();
  await openDecision(page, "api-rename");
  await expect(page.locator("#now .closed .turns > li")).toHaveCount(2);
  await expect(page.locator("#now #think")).toHaveCount(0);
});

test("Use Jordan's words offers the next scripted turn", async ({ page }) => {
  await openDecision(page, "onsite-flight");
  await page.locator("#now .example button").click();
  await expect(page.locator("#think")).toHaveValue("Let's take the 9:40.");
  await sendBtn(page).click();
  await reply(page);
  await page.locator("#now .example button").click();
  await expect(page.locator("#think")).not.toHaveValue("");
});

test("at 320px: a thread, a long decision button, payload lines and prototypes fit without sideways scroll @narrow", async ({ page }) => {
  const wide = () => page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as Promise<number>;
  await openDecision(page, "incident-action-items");
  await say(page, "File all five as drafted because the volunteers already agreed in the meeting. As long as each ticket links the incident doc.");
  await expect(sendBtn(page)).toHaveText("File all five as drafted");
  expect(await wide(), "incident-action-items").toBeLessThanOrEqual(0);
  for (const id of ["api-rename", "settings-redesign"]) {
    await openDecision(page, id);
    await page.locator("#now .opt").first().click();
    expect(await wide(), id).toBeLessThanOrEqual(0);
  }
});

test("a morning saved by an earlier version starts fresh", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("bugme.state.v3", JSON.stringify({ cards: {}, rules: [], facts: [], answered: { "incident-action-items": { final: "A" } }, flows: {} }));
  });
  await page.reload();
  await expect(page.locator("#overnight")).toContainText("questions overnight");
  expect(await page.evaluate("localStorage.getItem('bugme.state.v3')")).toBeNull();
  expect(await answered(page, "incident-action-items")).toBeUndefined();
  expect(STORE_KEY).toBe("bugme.state.v4");
});

test("starting the morning over gives the card a fresh conversation", async ({ page }) => {
  await openDecision(page, "api-rename");
  await say(page, "Keep user_id, because integrators parse v1 responses.");
  await goRecord(page);
  await page.getByRole("button", { name: "Start the morning over" }).click();
  await openDecision(page, "api-rename");
  await expect(turns(page)).toHaveCount(0);
  await expect(page.locator("#think")).toHaveValue("");
});
