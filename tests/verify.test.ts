import { describe, it, expect } from "vitest";
import { normalize, matchQuote, verifyDraft, stripSentencesCiting, replaceCites } from "../lib/agent/verify";

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

  it("tolerates a space after the colon", () => {
    const results = verifyDraft("The clause applies. [cite: E1]", evidenceById, pagesById);
    expect(results).toEqual([{ short_id: "E1", ok: true, score: 1 }]);
  });

  it("tolerates a comma-separated list of ids in one marker", () => {
    const evidence = {
      ...evidenceById,
      E2: { short_id: "E2", quote: "a continuous waiting period of 36 months", page_id: "p1", verified: true },
    };
    const results = verifyDraft("The clause applies. [cite: E1, E2]", evidence, pagesById);
    expect(results.map((r) => r.short_id).sort()).toEqual(["E1", "E2"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("stripSentencesCiting", () => {
  it("drops only sentences citing a failed id, keeping the rest", () => {
    const body = "First claim holds [cite:E1]. Second claim fails [cite:E2]. Third claim holds [cite:E1].";
    expect(stripSentencesCiting(body, ["E2"])).toBe("First claim holds [cite:E1]. Third claim holds [cite:E1].");
  });

  it("drops a sentence whose marker lists a failed id alongside a valid one", () => {
    const body = "Combined claim [cite: E1, E2]. Clean claim [cite:E1].";
    expect(stripSentencesCiting(body, ["E2"])).toBe("Clean claim [cite:E1].");
  });

  it("returns the body unchanged when there are no failed ids", () => {
    const body = "A sentence. [cite:E1]";
    expect(stripSentencesCiting(body, [])).toBe(body);
  });
});

describe("replaceCites", () => {
  it("passes the split id list to the renderer for a comma marker", () => {
    const rendered = replaceCites("Claim. [cite: E1, E2]", (ids) => `(${ids.join("+")})`);
    expect(rendered).toBe("Claim. (E1+E2)");
  });
});
