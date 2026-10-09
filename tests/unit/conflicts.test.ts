import { describe, expect, it } from "vitest";
import { verifiedConflicts } from "../../src/shared/route";
import { decision, facts, routeOutput, rules } from "./helpers";

describe("verifiedConflicts", () => {
  const d = decision("sdk-dependency");

  it("drops a conflict whose quote is in no rule or fact (no invented pushback)", () => {
    const out = routeOutput(d, { conflicts: [{ option: "B", quoted: "Jordan never flies on Fridays." }] });
    expect(verifiedConflicts(out, rules, facts)).toEqual([]);
  });

  it("keeps a faithful quote and replaces it with the exact source text", () => {
    const f1 = facts.find((f) => f.id === "F1")!;
    const loose = `  ${f1.text.toUpperCase().replace(/;/, ";  ")}`;
    const out = routeOutput(d, { conflicts: [{ option: "A", quoted: loose }] });
    expect(verifiedConflicts(out, rules, facts)).toEqual([{ option: "A", quoted: f1.text }]);
  });

  it("verifies against rules as well as facts", () => {
    const r = rules.find((x) => x.id === "R12")!;
    const out = routeOutput(d, { conflicts: [{ option: "B", quoted: r.text }] });
    expect(verifiedConflicts(out, rules, facts)).toEqual([{ option: "B", quoted: r.text }]);
  });
});
