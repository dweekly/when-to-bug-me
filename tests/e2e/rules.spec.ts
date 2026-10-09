// Editable written rules (build plan, item 3): editing a rule re-routes the decisions it touches, and
// the change note quotes the edited rule.
import { expect, test } from "@playwright/test";
import { freshPage } from "./helpers";

const NEW_R12 = "Travel: never book flights that leave before 8am.";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("editing R12 re-routes the flight to 'Your decision' quoting the new rule", async ({ page }) => {
  const flight = page.locator("#agenda").getByRole("button", { name: /6:05am flight/ });
  await expect(flight.locator(".r").first()).toContainText("Quick check-in");

  await page.getByRole("button", { name: /^Edit rule R12/ }).click();
  await page.getByLabel("Rule R12").fill(NEW_R12);
  await page.getByRole("button", { name: "Save and re-route" }).click();

  await expect(page.locator("#rules")).toContainText(NEW_R12);
  await expect(flight.locator(".r").first()).toContainText("Your decision");
  const note = flight.locator(".change-note");
  await expect(note).toContainText("Moved from “Quick check-in” to “Your decision”");
  // The quote must carry the edited rule's words; where its final period lands is presentation.
  await expect(note).toContainText(`because you edited R12: “${NEW_R12.replace(/\.$/, "")}`);
});
