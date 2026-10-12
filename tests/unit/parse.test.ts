import { describe, expect, it } from "vitest";
import decisions from "../../fixtures/decisions.json";
import { EXAMPLES } from "../../src/shared/examples";
import { answerParts, drawableMarks, fakeParse, findQuote, guidanceText, parseParseOutput, sendPlan } from "../../src/shared/parse";
import { parseSchema } from "../../src/shared/prompts";
import type { Decision, Mark } from "../../src/shared/types";

const byId = new Map((decisions as Decision[]).map((d) => [d.id, d]));
const rename = byId.get("api-rename")!;

describe("quotes are literal", () => {
  it("finds an exact substring and nothing looser", () => {
    expect(findQuote("I'd keep user_id.", "keep user_id")).toEqual({ start: 4, end: 16 });
    expect(findQuote("I'd keep  user_id.", "keep user_id")).toBeNull(); // whitespace differs
    expect(findQuote("I'd keep user_id.", "Keep user_id")).toBeNull(); // case differs
    expect(findQuote("anything", "   ")).toBeNull();
  });
});

describe("parseParseOutput", () => {
  const text = "I'd keep user_id. Integrators parse v1. But document account_id. How many read it?";
  it("keeps exact marks and drops inexact ones", () => {
    const out = parseParseOutput({ choice: "B", marks: [{ kind: "choice", quote: "I'd keep user_id." }, { kind: "why", quote: "integrators parse v1" }] }, rename, text);
    expect(out.marks).toEqual([{ kind: "choice", quote: "I'd keep user_id." }]);
  });
  it("rejects a choice that is not an option key, other or none", () => {
    expect(() => parseParseOutput({ choice: "C", marks: [] }, rename, text)).toThrow();
    expect(() => parseParseOutput({ choice: "B" }, rename, text)).toThrow();
  });
  it("keeps at most eight marks and ignores malformed ones", () => {
    const many = Array.from({ length: 12 }, () => ({ kind: "why", quote: "Integrators parse v1." }));
    expect(parseParseOutput({ choice: "none", marks: [{ kind: "nope", quote: "x" }, ...many] }, rename, text).marks).toHaveLength(8);
  });
  it("needs the person's words for something else, and drops choice marks when there is no choice", () => {
    expect(parseParseOutput({ choice: "other", marks: [] }, rename, text).choice).toBe("none");
    expect(parseParseOutput({ choice: "none", marks: [{ kind: "choice", quote: "I'd keep user_id." }] }, rename, text).marks).toEqual([]);
  });
  it("schema limits choice to the decision's keys plus other and none", () => {
    expect(parseSchema(["A", "B"]).properties.choice.enum).toEqual(["A", "B", "other", "none"]);
  });
});

describe("the stand-in parser", () => {
  it("reads Jordan's API narration: choice, reasons, condition, question", () => {
    const n = EXAMPLES.find((e) => e.id === "api-rename")!.narration;
    const out = fakeParse(rename, n);
    expect(out.choice).toBe("B");
    expect(new Set(out.marks.map((m) => m.kind))).toEqual(new Set(["choice", "but", "ask"]));
    for (const m of out.marks) expect(n.includes(m.quote)).toBe(true);
  });
  it("splits inline reasons and conditions without changing the words", () => {
    const t = "File them all, as long as each ticket links the incident doc.";
    const out = fakeParse(byId.get("incident-action-items")!, t);
    expect(out.marks.map((m) => m.kind)).toEqual(["but"]); // "File them all" is not a full option label
    const r = fakeParse(rename, "Keep user_id because integrators parse v1.");
    expect(r.choice).toBe("B");
    expect(r.marks).toEqual([{ kind: "choice", quote: "Keep user_id" }, { kind: "why", quote: "because integrators parse v1." }]);
  });
  it("ignores negated and questioned options, and calls two options ambiguous", () => {
    expect(fakeParse(rename, "Don't rename to account_id.").choice).toBe("none");
    expect(fakeParse(rename, "Should we rename to account_id?").choice).toBe("none");
    expect(fakeParse(rename, "Rename to account_id or keep user_id, not sure.").choice).toBe("none");
  });
  it("takes the last stated choice, and only its words", () => {
    const out = fakeParse(rename, "Rename to account_id. Actually, keep user_id.");
    expect(out.choice).toBe("B");
    expect(out.marks.filter((m) => m.kind === "choice").map((m) => m.quote)).toEqual(["Actually, keep user_id."]);
    expect(answerParts(fakeParse(rename, "Rename to account_id. Instead, ship both fields for a release.").marks).course).toBe("Instead, ship both fields for a release.");
  });
  it("a later clause naming both options undoes an earlier choice", () => {
    const out = fakeParse(rename, "Keep user_id. Actually, rename to account_id or keep user_id, not sure.");
    expect(out.choice).toBe("none");
    expect(out.marks.filter((m) => m.kind === "choice")).toEqual([]);
  });
  it("hears something else", () => {
    const out = fakeParse(rename, "Instead, ship both fields for a release.");
    expect(out.choice).toBe("other");
    expect(answerParts(out.marks).course).toBe("Instead, ship both fields for a release.");
  });
});

describe("what goes into the answer path", () => {
  const marks: Mark[] = [
    { kind: "choice", quote: "I'd keep user_id." },
    { kind: "why", quote: "Integrators parse v1." },
    { kind: "but", quote: "But document account_id." },
    { kind: "ask", quote: "How many read it?" },
  ];
  it("joins the person's phrases verbatim, with an empty reason when none was marked", () => {
    expect(answerParts(marks)).toEqual({ reason: "Integrators parse v1.", conditions: "But document account_id.", course: "I'd keep user_id." });
    expect(answerParts([marks[0]]).reason).toBe("");
    expect(guidanceText(answerParts(marks))).toBe("Integrators parse v1. But document account_id.");
  });
  it("labels Send by what it will do", () => {
    expect(sendPlan(rename, "B", marks, []).label).toBe("Send: keep user_id, with one condition");
    expect(sendPlan(rename, "A", [], []).label).toBe("Send: rename to account_id");
    expect(sendPlan(rename, "other", [{ kind: "choice", quote: "Ship both." }], []).kind).toBe("other");
    expect(sendPlan(rename, null, marks, ["How many read it?"])).toMatchObject({ kind: "ask-agent", questions: ["How many read it?"] });
    expect(sendPlan(rename, null, [], []).kind).toBe("nothing");
  });
  it("draws overlapping marks once but keeps them all for the answer", () => {
    const text = "Keep it because users rely on it, but tell them.";
    const m: Mark[] = [{ kind: "why", quote: "because users rely on it, but tell them" }, { kind: "but", quote: "but tell them" }];
    expect(drawableMarks(text, m).map((x) => x.kind)).toEqual(["why"]);
    expect(answerParts(m).conditions).toBe("but tell them");
  });
});
