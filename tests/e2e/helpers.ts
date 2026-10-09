// Shared steps for the end-to-end specs. Page-side code is passed to page.evaluate as strings
// because the repo's tsconfig has no DOM lib (it targets the Worker); the strings run in the browser.
import { type Page, expect } from "@playwright/test";

export const STORE_KEY = "bugme.state.v1";

/** Open the page with empty browser storage and wait for the first render. */
export async function freshPage(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate("localStorage.clear()");
  await page.reload();
  await waitForLoad(page);
}

export async function waitForLoad(page: Page): Promise<void> {
  await expect(page.locator("#overnight")).toContainText("Overnight your agents raised");
  await expect(page.locator("#now article.card")).toBeVisible();
}

/** The page's persisted state, as main.ts writes it to localStorage. */
export interface StoredState {
  answered: Record<string, { initial: string; final: string; basis: string; marks: string[]; pushback: string | null }>;
  settledMarks: Record<string, string[]>;
  reopened: string[];
  record: { kind: string; id?: string; [k: string]: unknown }[];
  rules: { id: string; text: string }[];
  facts: { id: string; text: string }[];
}

export async function stored(page: Page): Promise<StoredState | null> {
  const raw = (await page.evaluate(`localStorage.getItem(${JSON.stringify(STORE_KEY)})`)) as string | null;
  return raw ? (JSON.parse(raw) as StoredState) : null;
}

/** Open a waiting decision from the agenda by a piece of its question text. */
export async function openFromAgenda(page: Page, text: string): Promise<void> {
  await page.locator("#agenda").getByRole("button", { name: new RegExp(escape(text)) }).click();
  await expect(page.locator("#now h3#now-q")).toContainText(text);
}

/** An option button on the card in front of the person, by its label. */
export function option(page: Page, label: string) {
  return page.locator("#now").getByRole("button", { name: new RegExp(`^[A-Z]\\. ${escape(label)}`) });
}

export function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
