// The voice firefly (src/page/voice.ts, docs/STAGE-3.md): off until clicked, then on across cards;
// speech goes only to a box on the card in front of the person, appended to what is typed; each card
// gets its own recognition session, and late results from an earlier one are dropped. Speech
// recognition is replaced by a stand-in the test drives.
import { type Page, expect, test } from "@playwright/test";
import { freshPage, goHome, openDecision, option, stored } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRec {
      lang = "";
      interimResults = false;
      continuous = false;
      stopped = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        const g = globalThis as unknown as { __recs: FakeRec[] };
        (g.__recs ??= []).push(this);
      }
      stop() {
        this.stopped = true;
        this.onend?.();
      }
    }
    (globalThis as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRec;
  });
  await freshPage(page);
});

/** Say a finished phrase through recognition session `n` (default: the latest). */
async function say(page: Page, words: string, n = -1): Promise<void> {
  await page.evaluate(
    ([w, i]) => {
      const recs = (globalThis as unknown as { __recs: { onresult: (e: unknown) => void }[] }).__recs;
      recs.at(i as number)!.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: w } }] });
    },
    [words, n] as const,
  );
}
const recCount = (page: Page) => page.evaluate("(globalThis.__recs ?? []).length") as Promise<number>;
const recStopped = (page: Page, n: number) => page.evaluate(`globalThis.__recs.at(${n}).stopped`) as Promise<boolean>;
const state = (page: Page) => page.locator("#voice").getAttribute("data-state");

test("off until clicked; then speech is appended to the Why box after what was typed", async ({ page }) => {
  await openDecision(page, "api-rename");
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "off");
  expect(await recCount(page)).toBe(0);
  await page.locator("#basis").fill("Typed first.");
  await page.locator("#voice-btn").click();
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "listening");
  await say(page, "then spoken");
  await expect(page.locator("#basis")).toHaveValue("Typed first. then spoken");
  await expect(page.locator("#voice-heard")).toContainText("then spoken");
});

test("a new card gets a new session; a late result from the old card is dropped", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  await openDecision(page, "settings-redesign");
  await expect.poll(() => recCount(page)).toBe(2);
  expect(await recStopped(page, 0)).toBe(true);
  await say(page, "words meant for the rename", 0);
  await expect(page.locator("#basis")).toHaveValue("");
  await say(page, "one page is simpler");
  await expect(page.locator("#basis")).toHaveValue("one page is simpler");
});

test("listening pauses on Home and resumes on the next card", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  await goHome(page);
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "paused");
  expect(await recStopped(page, 0)).toBe(true);
  await openDecision(page, "settings-redesign");
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "listening");
});

test("in Not now, speech goes to the reason, not the answer", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  await page.locator("#now .not-now").click();
  await page.locator(".chip-btn").first().click();
  await say(page, "the SDK owners' view on renames");
  await expect(page.locator("#punt-reason")).toHaveValue("the SDK owners' view on renames");
  expect((await stored(page))?.flows?.["api-rename"]?.basis ?? "").toBe("");
});

test("speech during the Undo window goes with the answer", async ({ page }) => {
  await page.evaluate("localStorage.setItem('bugme.undoMs', '1500')");
  await page.reload();
  await openDecision(page, "incident-action-items");
  await page.locator("#voice-btn").click();
  await option(page, "File all five as drafted").click();
  await say(page, "the volunteers already agreed");
  await expect.poll(async () => (await stored(page))?.answered?.["incident-action-items"]?.basis, { timeout: 5000 }).toBe("the volunteers already agreed");
});

test("a refused microphone stops listening and says so", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  await page.evaluate("globalThis.__recs.at(-1).onerror({ error: 'not-allowed' })");
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "blocked");
  await expect(page.locator("#voice-note")).toContainText("Microphone unavailable");
});

test("turning it off stops the session, and a late result writes nothing", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  await page.locator("#voice-btn").click();
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "off");
  expect(await recStopped(page, 0)).toBe(true);
  await say(page, "too late", 0);
  await expect(page.locator("#basis")).toHaveValue("");
  expect(await state(page)).toBe("off");
});

test("a finished decision opened later has no box for speech, so listening pauses", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await option(page, "File all five as drafted").click();
  await expect.poll(async () => Boolean((await stored(page))?.answered?.["incident-action-items"])).toBe(true);
  await page.evaluate(() => {
    const k = "bugme.state.v1";
    const st = JSON.parse(localStorage.getItem(k)!);
    delete st.flows["incident-action-items"];
    localStorage.setItem(k, JSON.stringify(st));
  });
  await page.reload();
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  await page.evaluate("location.hash = '#/d/incident-action-items'");
  await expect(page.locator("#now .closed")).toBeVisible();
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "paused");
  expect(await recStopped(page, 0)).toBe(true);
});

test("speech-service failures back off, then stop and say so", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  for (let i = 0; i < 3; i++) {
    await expect.poll(() => recCount(page), { timeout: 5000 }).toBe(i + 1);
    await page.evaluate("globalThis.__recs.at(-1).onerror({ error: 'network' }); globalThis.__recs.at(-1).onend()");
  }
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "blocked");
  await expect(page.locator("#voice-note")).toContainText("isn't responding");
  await page.waitForTimeout(1500);
  expect(await recCount(page)).toBe(3); // no further retries once it has given up
});

test("silence is not a failure: the session restarts right away", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  for (let i = 0; i < 4; i++) await page.evaluate("globalThis.__recs.at(-1).onerror({ error: 'no-speech' }); globalThis.__recs.at(-1).onend()");
  expect(await recCount(page)).toBe(5);
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "listening");
});

test("a phrase still being spoken when the Undo window ends goes with the answer", async ({ page }) => {
  await page.evaluate("localStorage.setItem('bugme.undoMs', '1200')");
  await page.reload();
  await openDecision(page, "incident-action-items");
  await page.locator("#voice-btn").click();
  await page.getByRole("button", { name: "Yes, but…" }).click();
  await option(page, "File all five as drafted").click();
  // Words heard but not final yet; the stand-in delivers them as final when asked to stop.
  await page.evaluate(() => {
    const rec = (globalThis as unknown as { __recs: { onresult: (e: unknown) => void; stop: () => void; onend: (() => void) | null }[] }).__recs.at(-1)!;
    rec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "only if every ticket links" } }] });
    rec.stop = function () {
      this.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "only if every ticket links the incident doc" } }] });
      this.onend?.();
    };
  });
  await expect.poll(async () => (await stored(page))?.answered?.["incident-action-items"]?.conditions, { timeout: 6000 }).toBe("only if every ticket links the incident doc");
});

/** Make the latest session hold words as unfinished, delivering them as final `delay` ms after stop(). */
async function holdPhrase(page: Page, interim: string, final: string, delay = 0): Promise<void> {
  await page.evaluate(
    ([i, f, ms]) => {
      const rec = (globalThis as unknown as { __recs: { onresult: (e: unknown) => void; stop: () => void; onend: (() => void) | null }[] }).__recs.at(-1)!;
      rec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: i } }] });
      rec.stop = function () {
        setTimeout(() => {
          this.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: f } }] });
          this.onend?.();
        }, ms as number);
      };
    },
    [interim, final, delay] as const,
  );
}

test("undoing and choosing again while a phrase finishes gives the new choice its own Undo window", async ({ page }) => {
  await page.evaluate("localStorage.setItem('bugme.undoMs', '1500')");
  await page.reload();
  await openDecision(page, "incident-action-items");
  await page.locator("#voice-btn").click();
  await option(page, "File all five as drafted").click();
  await holdPhrase(page, "the volunteers", "the volunteers agreed", 900);
  await page.waitForTimeout(1700); // the first window has closed; its phrase is still finishing
  await page.locator(".undo-bar").getByRole("button", { name: "Undo" }).click();
  await option(page, "Show me the list first").click();
  await page.waitForTimeout(700); // the first window's phrase has finished by now
  expect((await stored(page))?.answered?.["incident-action-items"]).toBeUndefined();
  await expect.poll(async () => (await stored(page))?.answered?.["incident-action-items"]?.final, { timeout: 6000 }).toBe("B");
});

test("Send this instead waits for a reason still being spoken", async ({ page }) => {
  await openDecision(page, "incident-action-items");
  await page.locator("#voice-btn").click();
  await page.getByRole("button", { name: "Something else" }).click();
  await page.locator("#other").fill("Assign the database one to me");
  await holdPhrase(page, "because I own", "because I own the database", 200);
  await page.getByRole("button", { name: "Send this instead" }).click();
  await expect.poll(async () => (await stored(page))?.answered?.["incident-action-items"]?.basis).toBe("because I own the database");
});

test("skip while a spoken reason finishes: nothing is sent, and a second click sends nothing twice", async ({ page }) => {
  const facts: string[] = [];
  page.on("request", (r) => r.url().includes("/api/fact") && facts.push(r.url()));
  await openDecision(page, "onsite-flight");
  await page.locator("#voice-btn").click();
  await option(page, "9:40am flight").click();
  const push = page.locator("#now .followup.push .primary");
  await expect(page.locator("#now .followup.push .primary, #why").first()).toBeVisible();
  if (await push.count()) await push.click();
  await expect(page.locator("#why")).toBeVisible();
  await holdPhrase(page, "school drop", "school drop-off is at 7:45", 800);
  await page.locator("#now .followup").getByRole("button", { name: "Tell Bug Me" }).click();
  await page.locator("#now .followup").getByRole("button", { name: "skip" }).click();
  await page.waitForTimeout(1200);
  expect(facts).toHaveLength(0);
  await expect(page.locator("#fact-text")).toHaveCount(0);
});

test("leaving the card while a set-aside reason finishes does not set it aside or pull you back", async ({ page }) => {
  await openDecision(page, "api-rename");
  await page.locator("#voice-btn").click();
  await page.locator("#now .not-now").click();
  await page.locator(".chip-btn").first().click();
  await page.locator("#punt-reason").fill("What the SDK owners think of renames.");
  await holdPhrase(page, "and the", "and the docs team", 800);
  await page.locator("#now .punt").getByRole("button", { name: "Set aside" }).click();
  await goHome(page);
  await page.waitForTimeout(1200);
  await expect(page).toHaveURL(/#\/$/);
  expect((await stored(page))?.punts?.["api-rename"]).toBeUndefined();
});
