// Stage 3's model contracts: the per-option notes in the routing answer, the schema that pins every
// option field to the decision's keys, and the clarifying-question answer.
import { describe, expect, it } from "vitest";
import { parseAskOutput } from "../../src/shared/ask";
import { MAX_OPTION_NOTES } from "../../src/shared/constants";
import { fakeAsk } from "../../src/shared/fakeModel";
import { routeSchema } from "../../src/shared/prompts";
import { parseRouteOutput } from "../../src/shared/route";
import { decision, routeOutput } from "./helpers";

const d = decision("onsite-flight");
const note = { pros: ["Cheaper"], cons: ["Very early"], consequence: "$212" };

describe("option notes", () => {
  it("accepts the object form the schema asks for, in option order", () => {
    const raw = { ...routeOutput(d), option_notes: { B: note, A: { ...note, consequence: "" } } };
    const out = parseRouteOutput(raw, d);
    expect(out.option_notes.map((n) => n.option)).toEqual(["A", "B"]);
    expect(out.option_notes[1].consequence).toBe("$212");
  });
  it("rejects notes that leave an option out", () => {
    expect(() => parseRouteOutput({ ...routeOutput(d), option_notes: { A: note } }, d)).toThrow(/every option/);
  });
  it("rejects an unknown option key", () => {
    expect(() => parseRouteOutput({ ...routeOutput(d), option_notes: { A: note, B: note, C: note } }, d)).toThrow();
  });
  it(`rejects more than ${MAX_OPTION_NOTES} pros`, () => {
    const many = { ...note, pros: Array.from({ length: MAX_OPTION_NOTES + 1 }, (_, i) => `pro ${i}`) };
    expect(() => parseRouteOutput({ ...routeOutput(d), option_notes: { A: many, B: note } }, d)).toThrow(/more than/);
  });
  it("rejects an empty phrase", () => {
    expect(() => parseRouteOutput({ ...routeOutput(d), option_notes: { A: { ...note, pros: ["  "] }, B: note } }, d)).toThrow(/empty/);
  });
});

describe("the routing schema", () => {
  it("pins every option field to the decision's keys", () => {
    const s = JSON.stringify(routeSchema(["A", "B"]));
    expect(s).toContain('"settle_option":{"type":"string","enum":["","A","B"]}');
    expect((s.match(/"option":\{"type":"string","enum":\["A","B"\]\}/g) ?? []).length).toBe(3); // guess, conflicts, send_down
    const notes = routeSchema(["A", "B"]).properties.option_notes;
    expect(notes.required).toEqual(["A", "B"]);
  });
});

describe("clarifying questions", () => {
  it("parses an answer and rejects a malformed one", () => {
    expect(parseAskOutput({ answerable: true, answer: " Yes. " })).toEqual({ answerable: true, answer: "Yes." });
    expect(() => parseAskOutput({ answerable: "yes", answer: "x" })).toThrow();
    expect(() => parseAskOutput({ answerable: true, answer: "" })).toThrow();
  });
  it("the fake model answers from the agent's context, or says it doesn't know", () => {
    expect(fakeAsk(d, "Are the fares refundable?").answerable).toBe(true);
    expect(fakeAsk(d, "Is there wifi aboard?").answerable).toBe(false);
  });
});
