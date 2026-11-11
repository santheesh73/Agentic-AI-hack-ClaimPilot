import { describe, it, expect } from "vitest";
import { clauseRefs, locateQuote } from "../lib/agent/machine";
import { normalize } from "../lib/ingest/normalize";

const matchesAny = (cited: string, text: string) => clauseRefs(cited).some((re) => re.test(text));

describe("clauseRefs", () => {
  it("finds a numbered clause cited inside a section reference", () => {
    const cited = "Section 6 (Disclosure and Non-Disclosure), Clause 6.2";
    expect(matchesAny(cited, "6.2 If a claim is made and it is found that ...")).toBe(true);
    expect(matchesAny(cited, "Section 6: Disclosure and Non-Disclosure")).toBe(true);
  });

  it("does not match a different clause number that merely contains the digits", () => {
    expect(matchesAny("Clause 6.2", "16.2 Something else")).toBe(false);
    expect(matchesAny("Clause 6.2", "6.21 Something else")).toBe(false);
    expect(matchesAny("Section 6", "Section 6.3 is a sub-clause")).toBe(false);
  });

  it("matches Excl ids with or without zero padding, but not a longer id", () => {
    expect(matchesAny("Clause Excl01 (Pre-Existing Diseases)", "Excl01 — Pre-Existing Diseases")).toBe(true);
    expect(matchesAny("Excl1", "Excl01 — Pre-Existing Diseases")).toBe(true);
    expect(matchesAny("Excl01", "Excl10 — Something")).toBe(false);
  });

  it("returns nothing for a citation with no clause id", () => {
    expect(clauseRefs("the policy terms")).toEqual([]);
  });
});

describe("locateQuote", () => {
  const quote = "Once the policy has been continuously renewed without a break for 48 months, this exclusion shall cease to apply.";
  const page3 = { id: "p3", text_norm: normalize(`Excl01 — Pre-Existing Diseases. ${quote} In case of enhancement...`) };
  const page4 = { id: "p4", text_norm: normalize("Excl02 — First 30-Day Waiting Period. Expenses related to ...") };

  it("keeps the stated page when the quote is on it", () => {
    expect(locateQuote(quote, "p3", [page3, page4])).toMatchObject({ page_id: "p3", ok: true });
  });

  it("re-attributes a verbatim quote labelled with the wrong page", () => {
    expect(locateQuote(quote, "p4", [page3, page4])).toMatchObject({ page_id: "p3", ok: true });
  });

  it("still fails a quote that is on no page", () => {
    const r = locateQuote("The insurer will refund all premiums on request without conditions.", "p4", [page3, page4]);
    expect(r).toMatchObject({ page_id: "p4", ok: false });
  });
});
