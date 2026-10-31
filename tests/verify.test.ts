import { describe, it, expect } from "vitest";
import { normalize, matchQuote, verifyDraft } from "../lib/agent/verify";

describe("normalize", () => {
  it("expands ligatures", () => {
    expect(normalize("beneﬁt")).toBe("benefit");
  });

  it("joins hyphenated line breaks", () => {
    expect(normalize("pre-\nexisting disease")).toBe("preexisting disease");
  });

  it("collapses extra whitespace", () => {
    expect(normalize("  waiting   period\n\n of 48   months ")).toBe(
      "waiting period of 48 months"
    );
  });

  it("converts curly quotes and dashes to ascii", () => {
    expect(normalize("the insurer’s decision – final")).toBe(
      "the insurer's decision - final"
    );
  });
});

describe("matchQuote", () => {
  const page = normalize(
    "4.1 Pre-existing Diseases: Any condition for which the insured person had " +
      "signs or symptoms prior to the policy inception shall be covered only after " +
      "a continuous waiting period of 36 months has elapsed since the policy start date."
  );

  it("matches an exact substring", () => {
    const { ok, score } = matchQuote(
      "a continuous waiting period of 36 months has elapsed",
      page
    );
    expect(ok).toBe(true);
    expect(score).toBe(1);
  });

  it("still matches with a one-word change", () => {
    const { ok, score } = matchQuote(
      "a continuous waiting period of 36 months has passed",
      page
    );
    expect(ok).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0.92);
  });

  it("fails an invented sentence", () => {
    const { ok } = matchQuote(
      "claims for maternity are excluded for the first nine months of cover",
      page
    );
    expect(ok).toBe(false);
  });

  it("requires exact substring for short quotes", () => {
    const { ok } = matchQuote("waiting period", page);
    expect(ok).toBe(true);
    const { ok: ok2 } = matchQuote("cooling period", page);
    expect(ok2).toBe(false);
  });
});

describe("verifyDraft", () => {
  const pageNorm = normalize(
    "4.1 Pre-existing Diseases: covered only after a continuous waiting period of 36 months."
  );
  const pagesById = { p1: { id: "p1", text_norm: pageNorm } };
  const evidenceById = {
    E1: { short_id: "E1", quote: "a continuous waiting period of 36 months", page_id: "p1", verified: true },
  };

  it("passes a valid cite", () => {
    const results = verifyDraft("The clause applies. [cite:E1]", evidenceById, pagesById);
    expect(results).toEqual([{ short_id: "E1", ok: true, score: 1 }]);
  });

  it("fails an unknown cite id", () => {
    const results = verifyDraft("Not covered. [cite:E99]", evidenceById, pagesById);
    expect(results).toEqual([{ short_id: "E99", ok: false, score: 0 }]);
  });
});
