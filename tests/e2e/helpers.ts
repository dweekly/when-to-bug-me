// Shared steps for the end-to-end specs. Page-side code is passed to page.evaluate as strings
// because the repo's tsconfig has no DOM lib (it targets the Worker); the strings run in the browser.
//
// The app lives at /app and shows one view at a time, chosen by the URL hash (src/page/router.ts):
// `#/` home (the overview, no decision card), `#/d/<id>` focus (one decision in #now),
// `#/between/<project>`, `#/settled`, `#/rules` and `#/record`. The helpers below move between them
// the way a person would (the bar's nav links, the agenda's rows), and wait for each view to draw.
import { type Page, expect } from "@playwright/test";

export const STORE_KEY = "bugme.state.v4";

/** Open the app with empty browser storage and wait for home to draw. */
export async function freshPage(page: Page): Promise<void> {
  await page.goto("/app#/");
  await page.evaluate("localStorage.clear()");
  await page.reload();
  await waitForHome(page);
}

/** Wait for the app to boot and draw whichever view the URL names. */
export async function waitForLoad(page: Page): Promise<void> {
  await expect(page.locator("#bar nav")).toBeVisible();
  await expect(page.locator("#view > *").first()).toBeVisible();
}

/** Wait for home: the overnight summary and the agenda. */
export async function waitForHome(page: Page): Promise<void> {
  await expect(page.locator("#overnight")).toContainText("questions overnight");
  await expect(page.locator("#agenda")).toBeAttached();
}

/** The persisted state, as state.ts writes it to localStorage. */
export interface StoredState {
  answered: Record<string, { initial: string; final: string; basis: string; marks: string[]; pushback: string | null; guess?: { option: string; p: number }[]; send_down: string; conditions?: string; other?: string }>;
  settledMarks: Record<string, string[]>;
  reopened: string[];
  record: { kind: string; id?: string; [k: string]: unknown }[];
  rules: { id: string; text: string }[];
  facts: { id: string; text: string }[];
  cards: Record<string, { route?: string; fact_quoted?: string; rule_quoted?: string; unavailable?: string }>;
  changes: Record<string, string>;
  pending: string[];
  evaluated: Record<string, true>;
  punts: Record<string, { id: string; kind: string; reason: string; at: string; instruction: string }>;
  puntHistory: Record<string, { id: string; kind: string; reason: string; instruction: string }[]>;
  flows?: Record<string, { basis: string; think?: string; choice?: string | null; turns?: { text: string }[] }>;
}

export async function stored(page: Page): Promise<StoredState | null> {
  const raw = (await page.evaluate(`localStorage.getItem(${JSON.stringify(STORE_KEY)})`)) as string | null;
  return raw ? (JSON.parse(raw) as StoredState) : null;
}

/** A link in the bar's nav, by its label. */
function navLink(page: Page, label: RegExp) {
  return page.locator("#bar nav").getByRole("link", { name: label });
}

export async function goHome(page: Page): Promise<void> {
  await navLink(page, /^Home$/).click();
  await waitForHome(page);
}

export async function goSettled(page: Page): Promise<void> {
  await navLink(page, /^Decided for you/).click();
  await expect(page.locator("#settled")).toBeVisible();
  await openSettledGroups(page);
}

/** Open every group on Decided for you (they start closed), as a person would to reach a job's actions. */
export async function openSettledGroups(page: Page): Promise<void> {
  const closed = page.locator("#settled .dgroup:not([open]) > summary");
  while (await closed.count()) await closed.first().click();
}

export async function goRules(page: Page): Promise<void> {
  await navLink(page, /^Rules$/).click();
  await expect(page.locator("#rules li").first()).toBeVisible();
}

export async function goRecord(page: Page): Promise<void> {
  await navLink(page, /^Record$/).click();
  await expect(page.locator("#export")).toBeVisible();
}

/** Open one decision in focus by its id, as a direct link would, and wait for its card. */
export async function openDecision(page: Page, id: string): Promise<void> {
  await page.goto(`/app#/d/${encodeURIComponent(id)}`);
  await expect(page).toHaveURL(new RegExp(`#/d/${escape(encodeURIComponent(id))}$`));
  await expect(page.locator("#now #now-q")).toBeVisible();
}

/** A project's group on home's queue (its heading and numbered items), by project name. */
export function projectGroup(page: Page, name: string) {
  return page.locator("#agenda .project").filter({ has: page.locator(".pname", { hasText: new RegExp(`^${escape(name)}$`) }) });
}

/** A waiting decision's link on home's queue, by a piece of its headline. */
export function agendaItem(page: Page, text: string) {
  return page.locator("#agenda a.item").filter({ hasText: text });
}

/** From anywhere, go home, find a waiting decision on the agenda by its text, and open it. */
export async function openFromAgenda(page: Page, text: string): Promise<void> {
  if (!(await page.locator("#agenda").count())) await goHome(page);
  await agendaItem(page, text).first().click();
  await expect(page.locator("#now h3#now-q")).toContainText(text);
}

/** An option button on the card in front of the person, by its label. */
export function option(page: Page, label: string) {
  // An option's accessible name starts with its label (the letter badge is decorative).
  return page.locator("#now .options").getByRole("button", { name: new RegExp(`^(?:[A-Z]\\. )?${escape(label)}`) });
}

/** Decide the card in front of the person: click the option (which picks it), then Send. */
/** Answer the card in front of the person: click the option (with any words in the same turn), Send,
 *  and carry the conversation to the decision. */
export async function decide(page: Page, label: string, words = ""): Promise<void> {
  await option(page, label).click();
  await expect(option(page, label)).toHaveAttribute("aria-pressed", "true");
  if (words) await page.locator("#think").fill(words);
  await page.locator("#now .send").click();
  await toDecision(page);
}

/** Wait for Bug Me's reply to the turn just sent (the typing dots gone, its turn last). */
export async function reply(page: Page): Promise<void> {
  await expect(page.locator("#now .turns li.typing")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator("#now .turns > li").last()).toHaveClass(/\bbug\b/, { timeout: 15000 });
}

/**
 * Carry the conversation on the card to its decision: after each reply, press the decision button if
 * Bug Me read it back, else tell it to go ahead ("Just do it.") and send.
 */
export async function toDecision(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await reply(page);
    const decideBtn = page.locator("#now .send.decide");
    if (await decideBtn.count()) {
      await decideBtn.click();
      return;
    }
    await page.locator("#think").fill("Just do it.");
    await page.locator("#now .send").click();
  }
  throw new Error("Bug Me never read the decision back");
}

/**
 * Answer with a click and no reason, as if Bug Me read the decision straight back without asking
 * anything (a live model may; the stand-in always asks "Why that one?"). One /api/converse reply is
 * stubbed, so the answer path after it, including the "I'm curious: why?" backstop, runs for real.
 */
export async function decideQuietly(page: Page, label: string): Promise<void> {
  await option(page, label).click();
  const key = await option(page, label).getAttribute("data-key");
  const ledger = { choice: key, choice_quote: null, course: null, action: "", why: [], conditions: [], questions: [], feedback: [], no_more_questions: false };
  // On the simulation the call is /api/converse; on the owner's page, /api/me/converse.
  await page.route("**/converse", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: `So: ${label}. Right?`, next: "confirm", ledger, heard: JSON.stringify([key, "", [], []]), source: "code" }) }),
  );
  await page.locator("#now .send").click();
  await reply(page);
  await page.unroute("**/converse");
  await page.locator("#now .send.decide").click();
}

/** Say one turn on the card in front of the person and wait for Bug Me's reply. */
export async function say(page: Page, text: string): Promise<void> {
  await page.locator("#think").fill(text);
  await page.locator("#now .send").click();
  await reply(page);
}

/** Edit a written rule on the rules view (going there first if needed) and save it. */
export async function editRule(page: Page, id: string, text: string): Promise<void> {
  if (!(await page.locator("#rules").count())) await goRules(page);
  await page.getByRole("button", { name: new RegExp(`^Edit rule ${escape(id)}:`) }).click();
  await page.getByLabel(`Rule ${id}`).fill(text);
  await page.getByRole("button", { name: "Save and re-route" }).click();
}

/**
 * Hold every request to `path` whose JSON body matches, until the returned release function is
 * called. Lets a test act while a model call is still out.
 */
export async function hold(page: Page, path: string, match: (b: Record<string, unknown>) => boolean = () => true): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = true;
  await page.route(`**${path}`, async (route) => {
    if (held && match(route.request().postDataJSON() ?? {})) await gate;
    await route.continue();
  });
  return () => {
    held = false;
    release();
  };
}

export function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
