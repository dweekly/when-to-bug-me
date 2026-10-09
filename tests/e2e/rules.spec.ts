// Editable written rules (build plan, item 3): editing a rule re-routes the decisions it touches, and
// the change note on home's agenda quotes the edited rule.
import { expect, test } from "@playwright/test";
import { agendaItem, editRule, expandProject, freshPage, goHome } from "./helpers";

const NEW_R12 = "Travel: never book flights that leave before 8am.";

test.beforeEach(async ({ page }) => {
  await freshPage(page);
});

test("editing R12 re-routes the flight to 'Your decision' quoting the new rule", async ({ page }) => {
  await expandProject(page, "Platform");
  const flight = agendaItem(page, "6:05am flight");
  await expect(flight.locator(".glyph")).toHaveAttribute("aria-label", "Quick check-in");

  await editRule(page, "R12", NEW_R12);
  await expect(page.locator("#rules")).toContainText(NEW_R12);

  await goHome(page);
  await expandProject(page, "Platform");
  await expect(flight.locator(".glyph")).toHaveAttribute("aria-label", "Your decision");
  const note = flight.locator(".change-note");
  await expect(note).toContainText("Moved from “Quick check-in” to “Your decision”");
  // The quote must carry the edited rule's words; where its final period lands is presentation.
  await expect(note).toContainText(`because you edited R12: “${NEW_R12.replace(/\.$/, "")}`);
});
