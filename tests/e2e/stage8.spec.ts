// Stage 8 (docs/STAGE-8.md): Dispatch on the stand-in server. A task becomes a brief; Copy command
// waits for every prerequisite; edits rebuild the command; questions lead to a redraft; the public
// demo shows a labeled synthetic report; and on /me, Copy stores the fields as copied and starts the
// clock, and a session's report shows on the brief.
import { type Page, expect, test } from "@playwright/test";
import { DISPATCH_EXAMPLES } from "../../src/shared/dispatchExamples";
import { freshPage, hold } from "./helpers";

const LIVE_KEY = process.env.BUGME_E2E_LIVE_TOKEN!;
const bearer = { authorization: `Bearer ${LIVE_KEY}` };

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await freshPage(page);
  await page.evaluate("localStorage.removeItem('bugme.dispatch.v1')");
});

async function draftExample(page: Page, id: string): Promise<void> {
  await page.goto("/app#/dispatch");
  await page.locator(`.demo-chip[data-example="${id}"]`).click();
  await expect(page.locator("#dispatch-task")).toHaveValue(DISPATCH_EXAMPLES.find((x) => x.id === id)!.task);
  await page.locator("#draft-brief").click();
  await expect(page.locator("#brief")).toBeVisible();
}

test("a task becomes a brief; Copy command waits for every prerequisite", async ({ page }) => {
  await draftExample(page, "pagerduty");
  await expect(page.locator("#brief .brief-meta")).toContainText("1h 30m · asks at 3h");
  await expect(page.locator("#brief .brief-meta")).toContainText("$6");
  const copy = page.locator("#copy-command");
  await expect(copy).toBeDisabled();
  await expect(page.locator("#brief .brief-actions .think-msg")).toHaveText("Tick 2 first.");
  // PagerDuty is needed and not connected: code made it the first prerequisite.
  const boxes = page.locator("#brief .brief-you input");
  await expect(page.locator("#brief .brief-you li").first()).toContainText("Connect PagerDuty");
  await boxes.nth(0).check();
  await expect(copy).toBeDisabled();
  await boxes.nth(1).check();
  await expect(copy).toBeEnabled();
  await copy.click();
  const copied = (await page.evaluate("navigator.clipboard.readText()")) as string;
  expect(copied).toMatch(/^claude --model 'claude-opus-5-5' --effort 'medium' --permission-mode 'auto' --allowedTools 'mcp__bugme' -- "\$\(cat <<'BRIEF'\n/);
  expect(copied).toContain("report_to_bug_me");
});

test("editing the setup rebuilds the command and the size line", async ({ page }) => {
  await draftExample(page, "billing-complaints");
  await page.locator("#brief .brief-more summary").click();
  const cmd = page.locator("#brief-cmd code");
  await expect(cmd).toContainText("--disallowedTools 'mcp__Slack'");
  await page.getByLabel("Model").selectOption("claude-sonnet-5-5");
  await page.getByLabel("Effort").selectOption("high");
  await expect(cmd).toContainText("--model 'claude-sonnet-5-5' --effort 'high'");
  await page.getByLabel("Estimate in minutes").fill("45");
  await expect(page.locator("#brief .brief-meta")).toContainText("45m · asks at 1h 30m");
  await expect(cmd).toContainText("At 90 minutes (2× the estimate)");
  // A struck-through tool turns back on; the list offers it again.
  await page.getByRole("button", { name: "Slack is off; turn it back on" }).click();
  await expect(cmd).not.toContainText("mcp__Slack");
  await page.getByLabel("Turn off another tool").selectOption("mcp__Slack");
  await expect(cmd).toContainText("--disallowedTools 'mcp__Slack'");
});

test("sensitive and not urgent: Bug Me recommends running locally, and the cloud command is the second choice", async ({ page }) => {
  await draftExample(page, "billing-complaints");
  await expect(page.locator("#brief .meta-chip.local")).toHaveText("🔒local");
  await expect(page.locator("#copy-brief")).toHaveClass(/primary/);
  await expect(page.locator("#copy-command")).toHaveText("Run in cloud anyway");
});

test("a short task gets questions; answering them redrafts the brief", async ({ page }) => {
  await page.goto("/app#/dispatch");
  await page.locator("#dispatch-task").fill("Make a status page");
  await page.locator("#draft-brief").click();
  await expect(page.locator(".dispatch-thread .turn-qs li")).toHaveText(["Who is this for, and by when?"]);
  await page.locator("#dispatch-answers").fill("For customers, by Friday.");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/dispatch") && Boolean(r.postDataJSON()?.answers));
  await page.locator("#redraft").click();
  expect((await sent).postDataJSON().answers).toBe("For customers, by Friday.");
  // The thread keeps what was said: the task and the answers, as the person's turns.
  await expect(page.locator(".dispatch-thread .turn.mine")).toHaveText(["Make a status page", "For customers, by Friday."]);
  await expect(page.locator(".dispatch-thread .turn-qs")).toHaveCount(0);
  await expect(page.locator(".briefs li")).toHaveCount(1); // the public redraft replaced the draft it answered
});

test("the public demo shows a labeled synthetic report after Copy command, and briefs survive a reload", async ({ page }) => {
  await draftExample(page, "usage-demo");
  await page.locator("#copy-command").click();
  await expect(page.locator(".brief-outcome")).toContainText("done · 38m of ~30m · asked once");
  await expect(page.locator(".brief-outcome .meta-chip")).toHaveText("synthetic");
  await page.reload();
  await expect(page.locator(".briefs li")).toHaveCount(1);
  await expect(page.locator(".briefs li")).toContainText("done");
});

test("on /me: Copy stores the fields as copied, and the session's report shows on the brief", async ({ page, request }) => {
  const cat = await request.post("/api/me/catalog", {
    headers: bearer,
    data: { servers: [{ name: "bugme", prefix: "mcp__bugme", status: "connected" }, { name: "GitHub", prefix: "mcp__GitHub", status: "connected" }], skills: [] },
  });
  expect(cat.ok(), await cat.text()).toBe(true);
  await page.goto(`/me#k=${encodeURIComponent(LIVE_KEY)}`);
  await page.goto("/me#/dispatch");
  await expect(page.locator(".demo-chip")).toHaveCount(0); // no demo tasks on the real queue
  await expect(page.locator(".dispatch")).toContainText("Describe the task, not the sensitive data");
  await page.locator("#dispatch-task").fill("Quick demo: tidy the README's install section for new contributors.");
  await page.locator("#draft-brief").click();
  await expect(page.locator("#brief")).toBeVisible();
  const id = (await page.locator(".briefs li.current a").getAttribute("href"))!.split("/").pop()!;
  await page.locator("#brief .brief-more summary").click();
  await page.getByLabel("Model").selectOption("claude-haiku-5-5");
  const stored = page.waitForResponse((r) => r.url().endsWith(`/api/me/briefs/${id}/dispatched`) && r.ok());
  await page.locator("#copy-command").click();
  await stored;
  const rep = await request.post(`/api/me/briefs/${id}/report`, { headers: bearer, data: { outcome: "stopped at tripwire", scope: "bigger", summary: "The install steps differ per OS; stopped to ask." } });
  expect(rep.ok(), await rep.text()).toBe(true);
  const briefs = (await (await request.get("/api/me/briefs", { headers: bearer })).json()) as { briefs: { id: string; model: string; dispatched_at?: string }[] };
  const b = briefs.briefs.find((x) => x.id === id)!;
  expect(b.model).toBe("claude-haiku-5-5");
  expect(b.dispatched_at).toBeTruthy();
  await page.reload();
  await page.locator(`.briefs a[href="#/dispatch/${id}"]`).click();
  await expect(page.locator(".brief-outcome")).toContainText("stopped at tripwire");
  await expect(page.locator(".brief-outcome")).toContainText("no asks · scope bigger");
});

test("words typed while a brief is drafting stay in the box", async ({ page }) => {
  await page.goto("/app#/dispatch");
  await page.locator("#dispatch-task").fill("Make a status page for customers by Friday please");
  const release = await hold(page, "/api/dispatch");
  await page.locator("#draft-brief").click();
  await expect(page.locator("#draft-brief")).toHaveText("Sizing it…");
  await page.locator("#dispatch-task").fill("And a second thing");
  release();
  await expect(page.locator("#brief")).toBeVisible();
  await expect(page.locator("#dispatch-task")).toHaveValue("And a second thing");
});

test("each brief keeps its own answers", async ({ page }) => {
  await page.goto("/app#/dispatch");
  for (const t of ["Make a status page", "Make a launch page"]) {
    await page.locator("#dispatch-task").fill(t);
    await page.locator("#draft-brief").click();
    await expect(page.locator("#brief h2")).toHaveText(t);
  }
  await page.locator("#dispatch-answers").fill("For the launch, by Monday.");
  await page.locator(".briefs a", { hasText: "Make a status page" }).click();
  await expect(page.locator("#brief h2")).toHaveText("Make a status page");
  await expect(page.locator("#dispatch-answers")).toHaveValue("");
  await page.locator(".briefs a", { hasText: "Make a launch page" }).click();
  await expect(page.locator("#dispatch-answers")).toHaveValue("For the launch, by Monday.");
});

test("a budget of zero counts; an estimate under a minute holds Copy until it's fixed", async ({ page }) => {
  await draftExample(page, "usage-demo");
  await page.locator("#brief .brief-more summary").click();
  await page.getByLabel("Budget in dollars").fill("0");
  await expect(page.locator("#brief .brief-meta")).toContainText("$0");
  await page.getByLabel("Estimate in minutes").fill("0.1");
  await expect(page.getByLabel("Estimate in minutes")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#copy-command")).toBeDisabled();
  await expect(page.locator("#copy-brief")).toBeDisabled();
  await expect(page.locator("#brief .brief-actions .think-msg")).toHaveText("Fix the time or $ first.");
  await expect(page.locator("#brief .brief-meta")).toContainText("30m · asks at 1h"); // the last good value stands
  await page.getByLabel("Estimate in minutes").fill("20");
  await expect(page.locator("#copy-command")).toBeEnabled();
  await expect(page.locator("#brief .brief-meta")).toContainText("20m · asks at 40m");
});

test("on a phone, the brief fits the width @narrow", async ({ page }) => {
  await draftExample(page, "pagerduty");
  expect(await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")).toBeLessThanOrEqual(0);
});
