// Hidden guesses, structurally (build plan): before the person answers, the guess is nowhere the page
// can read it: not in the DOM, not in the queue response, not in the bundle, and the fixtures and
// recorded run are not served as static files.
import { expect, test } from "@playwright/test";
import { openDecision, waitForLoad } from "./helpers";

/** Text that would appear if a guess structure leaked in JSON form. */
const LEAKS = ['"guess"', '"p":', '"send_down"', '"conflicts"'];

test("no guess in the DOM, the queue response or the page bundle before answering", async ({ page }) => {
  await page.goto("/app#/");
  // Let the first load's queue request finish, so the listener below can only catch the reload's
  // (otherwise it could catch the first one, whose body the browser discards on reload).
  await waitForLoad(page);
  await page.evaluate("localStorage.clear()");
  const queue = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/queue");
  await page.reload();
  const queueBody = await (await queue).text();
  await waitForLoad(page);

  // The queue really did deliver sealed cards; otherwise "no guess" would prove nothing.
  const q = JSON.parse(queueBody) as { cards: { id: string; sealed?: string }[]; mode: string };
  expect(q.mode).toBe("fake");
  expect(q.cards.length).toBeGreaterThan(20);
  for (const c of q.cards) expect(c.sealed, c.id).toMatch(/^v\d+\./);

  const homeHtml = (await page.evaluate("document.documentElement.outerHTML")) as string;
  // Home has no decision card, so also look at a card in focus before it is answered.
  await openDecision(page, "onsite-flight");
  const focusHtml = (await page.evaluate("document.documentElement.outerHTML")) as string;
  expect(focusHtml).toContain('id="now-q"');
  const appJs = await (await page.request.get("/app.js")).text();
  expect(appJs.length).toBeGreaterThan(1000);
  for (const leak of LEAKS) {
    expect(queueBody, `queue contains ${leak}`).not.toContain(leak);
    expect(homeHtml, `home DOM contains ${leak}`).not.toContain(leak);
    expect(focusHtml, `focus DOM contains ${leak}`).not.toContain(leak);
    expect(appJs, `app.js contains ${leak}`).not.toContain(leak);
  }
  // Nor is the guess shown in words.
  await expect(page.locator("#now .reveal-line")).toHaveCount(0);
});

for (const path of ["/fixtures/decisions.json", "/fixtures/recorded.json", "/fixtures/captures/recorded.json", "/fixtures/rules.json", "/recorded.json", "/decisions.json"]) {
  test(`does not serve ${path}`, async ({ request }) => {
    const res = await request.get(path);
    const body = await res.text();
    let isJson = true;
    try {
      JSON.parse(body);
    } catch {
      isJson = false;
    }
    expect(res.status() === 404 || !isJson, `${path} returned ${res.status()} with JSON`).toBe(true);
  });
}
