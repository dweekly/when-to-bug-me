// Stage 9 (docs/STAGE-9.md): the runner's page, on the stand-in model with a stub `claude` and a stub
// `open` (tests/fixtures/start-runner.mjs). Launch waits for every tick and a trusted repo, passes the
// brief's argv, launches once however often it's pressed, and then shows how the session is doing; an
// ask that arrives shows without a reload; How? shows steps; Do it with me opens Terminal.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const ROOT = resolve(".wrangler/e2e-runner");
const FAKE = `${ROOT}/fake.json`;
const KEY = process.env.BUGME_E2E_LIVE_TOKEN!;
type Fake = { calls: { args: string[]; cwd: string }[]; sessions: { id: string; name: string; state?: string; status?: string; waitingFor?: string }[]; mcp: Record<string, [string, string][]>; failLaunch?: boolean };
const fake = (): Fake => ({ calls: [], sessions: [], ...JSON.parse(readFileSync(FAKE, "utf8")) });
const setFake = (f: (x: Fake) => void) => {
  const x = fake();
  f(x);
  writeFileSync(FAKE, JSON.stringify(x));
};

async function signIn(page: Page): Promise<void> {
  await page.goto(`/me#k=${encodeURIComponent(KEY)}`);
  await expect(page.locator("#bar nav")).toBeVisible();
}

async function draft(page: Page, task: string): Promise<string> {
  await page.goto("/me#/dispatch");
  await page.locator("#dispatch-task").fill(task);
  await page.locator("#draft-brief").click();
  await expect(page.locator("#brief")).toBeVisible();
  return decodeURIComponent(page.url().split("#/dispatch/")[1]);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("the runner is owner-only: no demo, no public model routes", async ({ request, baseURL }) => {
  expect((await request.post("/api/dispatch", { data: { task: "x" }, headers: { origin: baseURL! } })).status()).toBe(404);
  expect((await request.get("/api/me/briefs")).status()).toBe(401);
  expect((await request.get("/runner/status")).status()).toBe(401);
});

test("Launch waits for every tick and a trusted repo, then starts one session with the brief's argv", async ({ page }) => {
  const id = await draft(page, "Hook the release bot up to PagerDuty so a failed release pages whoever is on call.");
  const launch = page.locator("#launch");
  await expect(launch).toBeDisabled();
  await expect(page.locator("#launch-repo option", { hasText: "untrusted" })).toBeDisabled();
  await page.locator("#launch-repo").selectOption("sandbox");
  await expect(launch).toBeDisabled();
  for (const box of await page.locator("#brief .brief-you input").all()) await box.check();
  await expect(launch).toBeEnabled();

  // PagerDuty is needed and not connected in that repo: the runner refuses, by name.
  await launch.click();
  await expect(page.locator("#brief .brief-actions .think-msg")).toContainText("Not connected in sandbox: PagerDuty");

  setFake((x) => (x.mcp = { default: [["bugme", "connected"], ["PagerDuty", "connected"]] }));
  // Pressed twice: one session.
  await Promise.all([launch.click(), page.locator("#launch").click({ timeout: 2000 }).catch(() => {})]);
  await expect(page.locator(".brief-session")).toContainText("Working");
  const bg = fake().calls.filter((c) => c.args[0] === "--bg");
  expect(bg).toHaveLength(1);
  const args = bg[0].args;
  expect(args[0]).toBe("--bg");
  expect(args[2]).toMatch(new RegExp(`^bugme-${id}-[a-z0-9]{8}$`));
  expect(args.slice(3, 6)).toEqual(["-n", args[2], "--mcp-config"]);
  expect(args).toEqual(expect.arrayContaining(["--allowedTools", "mcp__bugme", "--permission-mode"]));
  expect(args.at(-2)).toBe("--");
  expect(args.at(-1)).toContain(`Bug Me brief ${id}`);
  expect(bg[0].cwd).toMatch(/\/dev\/sandbox$/);
  await expect(page.locator("#copy-attach")).toContainText(`claude attach ${fake().sessions[0].id}`);
  await expect(page.locator(".briefs li.current .brief-row-meta")).toContainText("launched");
  // A launch with no Copy still counts as sent in the weekly-review sketch (docs/STAGE-10.md, 10c).
  await page.goto("/me#/review");
  await expect(page.locator(`.rv-briefs li[data-brief="${id}"] .rv-dfacts`)).toContainText("no report yet");
});

test("the session line follows the session, and an ask shows without a reload", async ({ page, request }) => {
  await page.goto("/me#/dispatch");
  await page.locator(".briefs li a").first().click();
  const line = page.locator(".brief-session");
  await expect(line).toContainText("Working");
  const id = decodeURIComponent(page.url().split("#/dispatch/")[1]);

  // Text typed into the task box survives the refreshes.
  await page.locator("#dispatch-task").fill("half a thought");
  setFake((x) => {
    x.sessions[x.sessions.length - 1].state = "blocked";
    x.sessions[x.sessions.length - 1].waitingFor = "permission prompt";
  });
  await page.locator("#dispatch-task").blur();
  await expect(line).toContainText("Needs you in Claude · permission prompt", { timeout: 20_000 });
  await expect(page.locator("#dispatch-task")).toHaveValue("half a thought");

  // The session asks Bug Me (as its MCP server would, with the owner's key and the brief's id).
  const ask = await request.post("/api/me/tickets", {
    headers: { authorization: `Bearer ${KEY}` },
    data: { question: "Which PagerDuty service should a failed release page?", project: "Release bot", brief: id, options: [{ key: "A", label: "Releases" }, { key: "B", label: "Platform on-call" }] },
  });
  expect(ask.ok()).toBe(true);
  await expect(line).toContainText("Waiting on you", { timeout: 20_000 });
  await expect(line.locator("a")).toHaveAttribute("href", /#\/d\/t-/);
});

test("How? shows steps; Do it with me opens Terminal on the Mac", async ({ page }) => {
  await draft(page, "Hook the release bot up to PagerDuty so a failed release pages whoever is on call.");
  const how = page.locator("#brief .brief-you .how").first();
  await how.click();
  await expect(how).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#brief .walk ol li").first()).toBeVisible();
  await expect(page.locator("#brief .walk")).toContainText("code stand-in");
  await page.locator("#walk-with-0").click();
  await expect(page.locator("#brief .brief-actions .think-msg")).toContainText("Opened a Terminal");
  const opened = readFileSync(`${ROOT}/opened.txt`, "utf8");
  expect(opened).toMatch(/^-a Terminal .*\/walk\/b-[a-z0-9]{10}-0\/walk\.command$/m);
});

test("on a phone, the launched brief fits the width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/me#/dispatch");
  await page.locator(".briefs li a").last().click();
  await expect(page.locator("#brief")).toBeVisible();
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
});

test("a setup edit survives the refresh, and an invalid estimate turns Launch off", async ({ page }) => {
  await draft(page, "Tidy the README intro so it says what the tool does in one line.");
  await page.locator("#brief .brief-more summary").click();
  // Two refreshes (the second with nothing new), then an edit, then something that redraws the card.
  await page.waitForTimeout(17_000);
  await page.getByLabel("Model").selectOption("claude-haiku-5-5");
  const here = page.url();
  await page.goto("/me#/dispatch");
  await page.goto(here);
  // Details stays open across redraws.
  await expect(page.locator("#brief .brief-more")).toHaveAttribute("open", "");
  await expect(page.getByLabel("Model")).toHaveValue("claude-haiku-5-5");
  for (const box of await page.locator("#brief .brief-you input").all()) await box.check();
  await page.locator("#launch-repo").selectOption("sandbox");
  await expect(page.locator("#launch")).toBeEnabled();
  await page.getByLabel("Estimate in minutes").fill("0");
  await expect(page.locator("#launch")).toBeDisabled();
  await expect(page.locator("#brief .brief-actions .think-msg")).toHaveText("Fix the time or $ first.");
});

test("the first ask from a project this page hasn't seen reaches Home without a reload", async ({ page, request }) => {
  await page.goto("/me#/");
  await expect(page.locator("#bar nav")).toBeVisible();
  const ask = await request.post("/api/me/tickets", {
    headers: { authorization: `Bearer ${KEY}` },
    data: { question: "Should the nightly export keep 30 days or 90 days of history?", project: "Export Tool", options: [{ key: "A", label: "30 days" }, { key: "B", label: "90 days" }] },
  });
  expect(ask.ok()).toBe(true);
  await expect(page.locator("#view")).toContainText("Export Tool", { timeout: 20_000 });
});

test("after a failed launch, a changed setup is what the retry sends", async ({ page }) => {
  const id = await draft(page, "Rename the CLI flag --verbose to --debug everywhere it's documented.");
  for (const box of await page.locator("#brief .brief-you input").all()) await box.check();
  await page.locator("#launch-repo").selectOption("sandbox");
  setFake((x) => (x.failLaunch = true));
  await page.locator("#launch").click();
  await expect(page.locator("#brief .brief-actions .think-msg")).toContainText("didn't start");
  setFake((x) => (x.failLaunch = false));
  await page.locator("#brief .brief-more summary").click();
  await page.getByLabel("Model").selectOption("claude-haiku-5-5");
  // Two refreshes, then a redraw: the edit is still there, and the retry sends it.
  await page.waitForTimeout(17_000);
  await page.goto("/me#/dispatch");
  await page.goto(`/me#/dispatch/${id}`);
  await expect(page.getByLabel("Model")).toHaveValue("claude-haiku-5-5");
  await page.locator("#launch").click();
  await expect(page.locator(".brief-session")).toContainText("Working");
  const bg = fake().calls.filter((c) => c.args[0] === "--bg" && c.args[2].startsWith(`bugme-${id}-`));
  expect(bg).toHaveLength(2);
  expect(bg[1].args[bg[1].args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
});

test("a repo trusted while the page is open becomes pickable without a reload", async ({ page }) => {
  await draft(page, "Add a CONTRIBUTING file with the test command.");
  const option = page.locator("#launch-repo option", { hasText: "untrusted" });
  await expect(option).toBeDisabled();
  const cj = `${ROOT}/claude.json`;
  const conf = JSON.parse(readFileSync(cj, "utf8"));
  conf.projects[realpathSync(`${ROOT}/dev/untrusted`)] = { hasTrustDialogAccepted: true };
  writeFileSync(cj, JSON.stringify(conf));
  await expect(page.locator('#launch-repo option[value="untrusted"]')).toBeEnabled({ timeout: 20_000 });
});

test("an edit made while Launch's save is out stays; the launch sends what was clicked", async ({ page }) => {
  const id = await draft(page, "Write a one-paragraph summary of the release process in RELEASING.md.");
  for (const box of await page.locator("#brief .brief-you input").all()) await box.check();
  await page.locator("#launch-repo").selectOption("sandbox");
  await page.locator("#brief .brief-more summary").click();
  // Hold the save until the edit is made.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/me/briefs/${id}/dispatched`, async (route) => {
    await held;
    await route.continue();
  });
  await page.locator("#launch").click();
  await page.getByLabel("Effort").selectOption("max");
  release();
  await expect(page.locator(".brief-session")).toBeVisible();
  const bg = fake().calls.filter((c) => c.args[0] === "--bg" && c.args[2].startsWith(`bugme-${id}-`));
  expect(bg[0].args[bg[0].args.indexOf("--effort") + 1]).not.toBe("max");
  await expect(page.getByLabel("Effort")).toHaveValue("max");
});

test("a typed number that isn't valid survives a refresh", async ({ page, request }) => {
  await draft(page, "Add a --version flag to the CLI.");
  await page.locator("#brief .brief-more summary").click();
  const est = page.getByLabel("Estimate in minutes");
  await est.fill("0");
  await page.locator("#brief h2").click(); // blur
  // Something changes on the server, so a refresh wants to redraw.
  await request.post("/api/me/dispatch", { headers: { authorization: `Bearer ${KEY}` }, data: { task: "Another task, to change the list." } });
  await page.waitForTimeout(17_000);
  await expect(est).toHaveValue("0");
  await expect(page.locator("#brief .brief-actions .think-msg")).toHaveText("Fix the time or $ first.");
});

test("a number being typed survives the How? steps arriving", async ({ page }) => {
  const id = await draft(page, "Hook the release bot up to PagerDuty so a failed release pages whoever is on call.");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/me/briefs/${id}/walk`, async (route) => {
    await held;
    await route.continue();
  });
  await page.locator("#brief .brief-you .how").first().click();
  await page.locator("#brief .brief-more summary").click();
  const est = page.getByLabel("Estimate in minutes");
  await est.fill("0");
  release();
  await expect(page.locator("#brief .walk ol li").first()).toBeVisible();
  await expect(est).toHaveValue("0");
  await expect(page.locator("#brief .walk-note")).toContainText("never needs your secrets");
});

test("the repo picked at the click is where it launches, even if the picker changes during the save", async ({ page }) => {
  // Two trusted repos to choose from.
  const cj = `${ROOT}/claude.json`;
  const conf = JSON.parse(readFileSync(cj, "utf8"));
  conf.projects[realpathSync(`${ROOT}/dev/untrusted`)] = { hasTrustDialogAccepted: true };
  writeFileSync(cj, JSON.stringify(conf));
  const id = await draft(page, "Add a CHANGELOG entry for the last release.");
  await expect(page.locator('#launch-repo option[value="untrusted"]')).toBeEnabled();
  for (const box of await page.locator("#brief .brief-you input").all()) await box.check();
  await page.locator("#launch-repo").selectOption("sandbox");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/me/briefs/${id}/dispatched`, async (route) => {
    await held;
    await route.continue();
  });
  await page.locator("#launch").click();
  await page.locator("#launch-repo").selectOption("untrusted");
  release();
  await expect(page.locator(".brief-session")).toBeVisible();
  const bg = fake().calls.filter((c) => c.args[0] === "--bg" && c.args[2].startsWith(`bugme-${id}-`));
  expect(bg).toHaveLength(1);
  expect(bg[0].cwd).toMatch(/\/dev\/sandbox$/);
});

test("a stricter permission mode saved during the tools check is what launches", async ({ page, request }) => {
  const id = await draft(page, "Hook the release bot up to PagerDuty so a failed release pages whoever is on call.");
  for (const box of await page.locator("#brief .brief-you input").all()) await box.check();
  await page.locator("#launch-repo").selectOption("sandbox");
  setFake((x) => {
    x.mcp = { default: [["bugme", "connected"], ["PagerDuty", "connected"]] };
    (x as Fake & { mcpSleepMs?: number }).mcpSleepMs = 3000;
  });
  await page.locator("#launch").click();
  // While the runner checks the tools, another device saves the brief in plan mode.
  await page.waitForTimeout(800);
  const b = (await (await request.get("/api/me/briefs", { headers: { authorization: `Bearer ${KEY}` } })).json()).briefs.find((x: { id: string }) => x.id === id);
  const saved = await request.post(`/api/me/briefs/${id}/dispatched`, {
    headers: { authorization: `Bearer ${KEY}` },
    data: { model: b.model, effort: b.effort, permission_mode: "plan", estimate_minutes: b.estimate_minutes, budget_usd: b.budget_usd, tools_off: b.tools_off, ticked: b.ticked },
  });
  expect(saved.ok()).toBe(true);
  await expect(page.locator(".brief-session")).toBeVisible({ timeout: 15_000 });
  setFake((x) => delete (x as Fake & { mcpSleepMs?: number }).mcpSleepMs);
  const bg = fake().calls.filter((c) => c.args[0] === "--bg" && c.args[2].startsWith(`bugme-${id}-`));
  expect(bg[0].args[bg[0].args.indexOf("--permission-mode") + 1]).toBe("plan");
});

test("onboarding on your own history: imported on the runner, interviewed, kept as facts and your note", async ({ page, request }) => {
  const history = JSON.parse(readFileSync("fixtures/history.json", "utf8")).decisions.slice(0, 12);
  const imported = await request.post("/api/me/onboarding", { headers: { authorization: `Bearer ${KEY}` }, data: { history } });
  expect(imported.ok()).toBe(true);
  await page.goto("/me#/welcome");
  await expect(page.locator(".welcome h1")).toHaveText("Getting to know you");
  await expect(page.locator("#step-read .welcome-stats")).toContainText("12 decisions");
  await expect(page.locator("#step-draft .note-line").first()).toBeVisible();
  // No DEMO REPLY on your own page: these are your answers.
  await page.locator("#start-interview").click();
  await expect(page.locator("#step-interview .demo-reply")).toHaveCount(0);
  await page.locator("#answer-q1").fill("Yes, always: that's how I work.");
  await page.locator("#revise-note").click();
  await expect(page.locator("#step-note .note-line").first()).toBeVisible();
  await page.locator("#keep-note").click();
  await expect(page.locator("#step-note")).toContainText("It's your note now");
  // Rules: the kept lines are facts you can edit, and the note is yours.
  await page.goto("/me#/rules");
  await expect(page.locator("#facts")).toContainText("onboarding");
  await expect(page.locator("#note-source")).toContainText("Drafted by Bug Me from 12 of your decisions");
  await page.locator("#facts .rtext").first().click();
  const ta = page.locator("#facts li.editing textarea");
  await ta.fill("Previews, not diffs. Always.");
  await page.locator("#facts li.editing").getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#facts")).toContainText("Previews, not diffs. Always.");
  await page.reload();
  await expect(page.locator("#facts")).toContainText("Previews, not diffs. Always.");
});

test("onboarding steps name their run: a newer import isn't acted on unseen, and a kept run is closed", async ({ page, request }) => {
  const history = JSON.parse(readFileSync("fixtures/history.json", "utf8")).decisions.slice(0, 10);
  const auth = { authorization: `Bearer ${KEY}` };
  await request.post("/api/me/onboarding", { headers: auth, data: { history } });
  await page.goto("/me#/welcome");
  await expect(page.locator("#start-interview")).toBeVisible();
  // Another import lands while the page shows the first.
  await request.post("/api/me/onboarding", { headers: auth, data: { history: history.slice(0, 8) } });
  await page.locator("#start-interview").click();
  await expect(page.locator(".welcome")).toContainText("A newer import replaced this one");
  // The current run, kept: no more changes to it.
  await page.reload();
  await page.locator("#start-interview").click();
  await page.locator("#answer-q1").fill("Yes.");
  await page.locator("#revise-note").click();
  await page.locator("#keep-note").click();
  await expect(page.locator("#step-note")).toContainText("It's your note now");
  await expect(page.locator("#change-answers")).toHaveCount(0);
  const run = (await (await request.get("/api/me/onboarding", { headers: auth })).json()).run;
  const late = await request.post("/api/me/onboarding/revise", { headers: auth, data: { run: run.id, answers: { q1: "No." } } });
  expect(late.status()).toBe(409);
});

test("a step another tab finished meanwhile isn't answered unseen", async ({ page, request }) => {
  const history = JSON.parse(readFileSync("fixtures/history.json", "utf8")).decisions.slice(0, 10);
  const auth = { authorization: `Bearer ${KEY}` };
  await request.post("/api/me/onboarding", { headers: auth, data: { history } });
  await page.goto("/me#/welcome");
  await page.locator("#start-interview").click();
  await page.locator("#answer-q1").fill("Yes.");
  // Another tab asks for the interview again: new questions this page hasn't shown.
  const shown = (await (await request.get("/api/me/onboarding", { headers: auth })).json()).run;
  expect((await request.post("/api/me/onboarding/interview", { headers: auth, data: { run: shown.id, rev: shown.rev } })).status()).toBe(200);
  await page.locator("#revise-note").click();
  await expect(page.locator(".welcome")).toContainText("changed in another tab");
  const now = (await (await request.get("/api/me/onboarding", { headers: auth })).json()).run;
  expect(now.revised).toBeUndefined();
});

test("an answer edited while Revise is out stays, and Revise again uses it; history without timings shows none", async ({ page, request }) => {
  // As npm run onboard sends it: no seconds.
  const history = JSON.parse(readFileSync("fixtures/history.json", "utf8")).decisions.slice(0, 10).map(({ seconds: _s, ...x }: Record<string, unknown>) => x);
  await request.post("/api/me/onboarding", { headers: { authorization: `Bearer ${KEY}` }, data: { history } });
  await page.goto("/me#/welcome");
  await expect(page.locator(".welcome-stats")).not.toContainText("≤5 s");
  await page.locator("#start-interview").click();
  await page.locator("#answer-q1").fill("Yes.");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/me/onboarding/revise", async (route) => {
    await held;
    await route.continue();
  });
  await page.locator("#revise-note").click();
  await page.locator("#answer-q1").fill("Only for cleanups.");
  release();
  await expect(page.locator(".welcome")).toContainText("changed an answer while Bug Me revised");
  await expect(page.locator("#answer-q1")).toHaveValue("Only for cleanups.");
  await page.unroute("**/api/me/onboarding/revise");
  const sent = page.waitForRequest((r) => r.url().includes("/api/me/onboarding/revise"));
  await page.locator("#revise-note").click();
  expect((await sent).postDataJSON().answers.q1).toBe("Only for cleanups.");
  await expect(page.locator("#keep-note")).toBeVisible();
});

test("a kept line's fact, edited or deleted, changes the note too, and deleting a fact re-checks what's waiting", async ({ page, request }) => {
  await page.goto("/me#/rules");
  const note = page.locator("#note");
  // The newest fact: a line of the note kept in the test before (the facts list is oldest first).
  const first = page.locator("#facts .rtext").last();
  const text = (await first.innerText()).trim();
  await expect(note).toContainText(text);
  await first.click();
  await page.locator("#facts li.editing textarea").fill("Edited in Rules.");
  await page.locator("#facts li.editing").getByRole("button", { name: "Save" }).click();
  await expect(note).toContainText("Edited in Rules.");
  await expect(note).not.toContainText(text);
  // A waiting ask, then a fact deleted: the waiting ask is checked again.
  await request.post("/api/me/tickets", { headers: { authorization: `Bearer ${KEY}` }, data: { question: "Ship the docs change now or tomorrow?", project: "Docs", options: [{ key: "A", label: "Now" }, { key: "B", label: "Tomorrow" }] } });
  await page.reload();
  const rerouted = page.waitForRequest((r) => r.url().includes("/api/me/route"));
  await page.locator("#facts .rtext", { hasText: "Edited in Rules." }).click();
  await page.locator("#facts li.editing").getByRole("button", { name: "delete" }).click();
  await rerouted;
  await expect(note).not.toContainText("Edited in Rules.");
});
