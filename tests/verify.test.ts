import { describe, it, expect } from "vitest";
import { normalize, matchQuote, verifyDraft, stripSentencesCiting, replaceCites, extractCites, findUnverifiableSentences, stripUnverified, splitSentences } from "../lib/agent/verify";

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

// --- Regression tests for audit findings F-001, F-002, F-004 ---

describe("matchQuote rejects meaning changes (F-001)", () => {
  const page = normalize(
    "Expenses related to the treatment of a pre-existing disease and its direct complications shall be excluded " +
      "until the expiry of 48 months of continuous coverage after the date of inception of the first policy with the insurer."
  );
  const original = "a pre-existing disease and its direct complications shall be excluded until the expiry of 48 months of continuous coverage";
  it("accepts the verbatim clause", () => expect(matchQuote(original, page).ok).toBe(true));
  it("rejects an inserted negation", () => expect(matchQuote(original.replace("shall be", "shall not be"), page).ok).toBe(false));
  it("rejects a changed number", () => expect(matchQuote(original.replace("48", "24"), page).ok).toBe(false));
  it("rejects excluded -> included", () => expect(matchQuote(original.replace("excluded", "included"), page).ok).toBe(false));
  it("still accepts a harmless typo", () => expect(matchQuote(original.replace("complications", "complicatons"), page).ok).toBe(true));
  it("threshold boundary: a quote just below 0.92 similarity fails", () => {
    const { ok, score } = matchQuote("a pre-existing condition and its indirect consequences shall be excluded until the end of 48 months of cover", page);
    expect(score).toBeLessThan(0.92);
    expect(ok).toBe(false);
  });
  it("short quotes (< 6 words) need an exact match even for a one-letter typo", () => {
    expect(matchQuote("shall be excluded until", page).ok).toBe(true);
    expect(matchQuote("shall be exclded until", page).ok).toBe(false);
  });
  it("empty quote fails", () => expect(matchQuote("   ", page)).toEqual({ ok: false, score: 0 }));
});

describe("citation parsing (F-002)", () => {
  it.each([
    ["[cite:E1]", ["E1"]], ["[CITE:e1]", ["E1"]], ["[cite: E1, E2]", ["E1", "E2"]], ["[cite:E1; E2]", ["E1", "E2"]],
    ["[cite:E1 E2]", ["E1", "E2"]], ["[cite:E1-E3]", ["E1", "E2", "E3"]], ["(cite:E1)", ["E1"]], ["[[cite:E1]]", ["E1"]],
    ["[cite:E1][cite:E2]", ["E1", "E2"]], ["[cite:E99]", ["E99"]],
  ])("%s parses to %j", (marker, ids) => expect(extractCites(`Covered. ${marker}`)).toEqual(ids));

  const pagesById = { p1: { id: "p1", text_norm: normalize("waiting period of 36 months") } };
  const evidenceById = { E1: { short_id: "E1", quote: "waiting period of 36 months", page_id: "p1", verified: true } };

  it("an uncited policy claim fails verification", () => {
    const r = verifyDraft("The waiting period expired. [cite:E1] Clause 9.4 of the policy guarantees reimbursement within 7 days.", evidenceById, pagesById);
    expect(r.find((x) => x.short_id === "UNCITED")?.ok).toBe(false);
  });
  it("an unrecognized marker format fails verification instead of passing vacuously", () => {
    const r = verifyDraft("The policy covers this in full [E1](cite).", evidenceById, pagesById);
    expect(r.some((x) => !x.ok)).toBe(true);
  });
  it("restating the insurer's rejection is not flagged as an uncited policy claim", () => {
    expect(findUnverifiableSentences("Your letter rejected my claim under Section 6 of the policy.")).toEqual([]);
  });
  it("facts and requests without policy terms are not flagged", () => {
    expect(findUnverifiableSentences("I was admitted on 2 August 2026. Please settle the claim of Rs. 92,500.")).toEqual([]);
  });
  // Regression: the live eval showed the first version of this check stripping
  // true statements about the insured and their attachments from letters.
  it.each([
    "I ported to this policy on 01 March 2025 from Star Health without any break.",
    "I had continuous coverage since 01 January 2021 under my previous insurer.",
    "Prior insurance policy documents showing continuous coverage since 01 January 2021.",
    "Portability approval documents.",
    "Regarding this rejection, I would like to clarify that before this policy I was covered under my employer's group plan.",
    "The claim was unfortunately rejected on 2020-10-20 on the grounds that expenses for cosmetic surgery are excluded.",
    "My waiting period under the earlier policy had completed by then.",
    "The discharge summary and the burns certificate are attached.",
    "Subject: Appeal for reconsideration of claim no. CLM/2026/905120 under Policy No. UGHI/2026/0204417.",
    "The claim for INR 148,000 was rejected on 2026-10-05 under Clause 4.2 (First 30-day Waiting Period) and Excl02, stating that treatment within 30 days is excluded.",
    "I am writing to formally appeal the rejection of my claim under Clause 6.2.",
    "Therefore, the invocation of Clause Excl01 for this hospitalization is incorrect.",
    "The rejection was communicated stating that expenses for cosmetic surgery are excluded as per the policy.",
  ])("does not flag the insured's own facts or attachments: %s", (sentence) => {
    expect(findUnverifiableSentences(sentence)).toEqual([]);
  });

  it.each([
    "Clause 9.4 of the policy also guarantees full reimbursement within 7 days.",
    "As per the policy, all pre-existing conditions are covered after 12 months.",
    "The policy waives all exclusions for senior citizens.",
    "Section 7 provides a 90-day grace period.",
    "The waiting period has expired.",
    "The exclusion no longer applies to my case.",
    "Excl03 does not cover this procedure.",
    "I believe Clause 9.4 guarantees full payment within 7 days.",
    "My documents confirm that Section 7 provides a 90-day grace period.",
    "The rejection was wrong because the policy guarantees full reimbursement of all hospital bills.",
  ])("still flags an uncited claim about the policy: %s", (sentence) => {
    expect(findUnverifiableSentences(sentence).map((u) => u.reason)).toEqual(["uncited_policy_claim"]);
  });

  it("the same claims pass when they carry a recognized citation", () => {
    expect(findUnverifiableSentences("The waiting period has expired. [cite:E1] The policy waives all exclusions. [cite:E2]")).toEqual([]);
  });

  it("headings are not checked", () => expect(findUnverifiableSentences("# Appeal under Clause 4.1")).toEqual([]));
});

describe("stripping keeps the right sentences and the structure (F-004)", () => {
  it("a marker after the full stop belongs to the sentence before it", () => {
    const body = "The waiting period has expired. [cite:E9] Please reconsider the claim. We attach the discharge summary.";
    expect(stripSentencesCiting(body, ["E9"])).toBe("Please reconsider the claim. We attach the discharge summary.");
  });
  it("keeps paragraphs and list items", () => {
    const body = "Para one sentence. [cite:E1]\n\nPara two has a bad cite [cite:E9]. It also says more.\n\n- bullet item one\n- bullet item two";
    expect(stripSentencesCiting(body, ["E9"])).toBe("Para one sentence. [cite:E1]\n\nIt also says more.\n\n- bullet item one\n- bullet item two");
  });
  it("does not split on abbreviations or decimals", () => {
    expect(splitSentences("Per Sec. 6.3 of the policy the claim is valid [cite:E9]. Thank you.")).toEqual([
      "Per Sec. 6.3 of the policy the claim is valid [cite:E9].",
      "Thank you.",
    ]);
    expect(stripSentencesCiting("Per Sec. 6.3 of the policy the claim is valid [cite:E9]. Thank you.", ["E9"])).toBe("Thank you.");
  });
  it("stripUnverified removes failed and uncited policy claims but keeps the relief request", () => {
    const body = "# Appeal\n\nThe waiting period has expired. [cite:E1] The policy waives all exclusions for senior citizens. [cite:E9] Please settle the claim of Rs 1,00,000.\n\nClause 9.4 guarantees payment in 7 days.";
    const out = stripUnverified(body, [{ short_id: "E1", ok: true, score: 1 }, { short_id: "E9", ok: false, score: 0 }]);
    expect(out).toBe("# Appeal\n\nThe waiting period has expired. [cite:E1] Please settle the claim of Rs 1,00,000.");
  });
});
