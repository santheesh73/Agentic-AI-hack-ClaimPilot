import { describe, it, expect } from "vitest";
import {
  EXCEPTION_MARKERS,
  clauseTextFor,
  findExceptionMarkers,
  firstUnresolvedException,
  hasExceptionMarker,
  isNotSure,
  splitClauses,
  type ExceptionReviewItem,
} from "../lib/agent/exceptions";
import { normalize } from "../lib/agent/verify";

describe("exception marker detector", () => {
  it("the marker list is a constant containing every required phrase", () => {
    for (const m of ["unless", "except", "other than", "provided that", "save where", "shall not apply", "excluding cases"]) {
      expect(EXCEPTION_MARKERS).toContain(m);
    }
  });

  it.each([
    ["joint replacement surgery (unless due to accident)", "unless"],
    ["excluded, except claims arising due to an accident", "except"],
    ["any treatment other than emergency care", "other than"],
    ["covered, provided that the premium is paid", "provided that"],
    ["not payable save where the insurer agrees", "save where"],
    ["This exclusion shall not apply for subsequent renewals", "shall not apply"],
    ["This exclusion shall not, however, apply if the insured has continuity benefits", "shall not, however, apply"],
    ["The rule holds, excluding cases of accident", "excluding cases"],
  ])("finds the marker in %j", (text, marker) => {
    expect(findExceptionMarkers(text)).toContain(marker);
  });

  it("is case-insensitive and tolerates line-wrapped phrases", () => {
    expect(hasExceptionMarker("UNLESS the insured is a minor")).toBe(true);
    expect(hasExceptionMarker("claims are payable Other\nThan in the first year")).toBe(true);
    expect(hasExceptionMarker("provided\n  that notice is given")).toBe(true);
  });

  it.each([
    "the unlessened path",
    "an exceptional case",
    "exceptions are listed in Schedule 2",
    "the excepted perils",
    "unlessness",
    "provided thatch",
    "pre-unless",
    "no marker here at all",
    "Expenses related to the treatment of a pre-existing disease shall be excluded until the expiry of 48 months.",
  ])("does not match inside other words: %j", (text) => {
    expect(hasExceptionMarker(text)).toBe(false);
  });

  it("reports each marker once, lowercased", () => {
    expect(findExceptionMarkers("Unless A. Unless B, except C")).toEqual(["unless", "except"]);
  });
});

describe("clauseTextFor", () => {
  const page = [
    "Excl02 — First 30-Day Waiting Period",
    "Expenses related to the treatment of any illness within 30 days from the first",
    "policy commencement date shall be excluded, except claims arising due to an",
    "accident, provided the same are covered.",
    "Excl03 — Specified Disease/Procedure Waiting Period",
    "Expenses related to the following shall be excluded until the expiry of 24 months:",
    "cataract, hernia of all types, joint replacement surgery (unless due to accident).",
    "Excl04 — Something Else",
    "Expenses related to dental treatment are excluded.",
  ].join("\n");

  it("splits a page into clause segments at clause headings", () => {
    expect(splitClauses(page)).toHaveLength(3);
  });

  it("returns the whole clause containing a partial quote, including an exception the quote omitted", () => {
    const text = clauseTextFor(page, "Expenses related to the following shall be excluded until the expiry of 24 months");
    expect(findExceptionMarkers(text)).toEqual(["unless"]);
    expect(text).toContain("joint replacement surgery (unless due to accident)");
  });

  it("does not leak another clause's exception into a clause without one", () => {
    const text = clauseTextFor(page, "Expenses related to dental treatment are excluded");
    expect(hasExceptionMarker(text)).toBe(false);
  });

  it("finds the clause even when the quote has a small extraction typo", () => {
    const text = clauseTextFor(page, "Expenses related to the treatment of any illness within 30 days from the frst policy commencement date shall be excluded");
    expect(text).toContain("Excl02");
  });

  it("continues a clause that runs onto the next page", () => {
    const p1 = "Excl02 — First 30-Day Waiting Period\nExpenses related to the treatment of any illness within 30 days from the first";
    const p2 = "policy commencement date shall be excluded, except claims arising due to an accident.\nExcl03 — Next\nOther text.";
    const text = clauseTextFor(p1, "Expenses related to the treatment of any illness within 30 days from the first", p2);
    expect(hasExceptionMarker(text)).toBe(true);
    expect(text).not.toContain("Excl03");
  });

  it("falls back to the quote itself when it is on no page segment", () => {
    expect(clauseTextFor(page, "a sentence that is nowhere on this page at all, honestly")).toBe(
      "a sentence that is nowhere on this page at all, honestly"
    );
  });
});

describe("firstUnresolvedException", () => {
  const letter = "The fracture resulted from osteoporosis and was not caused by any accident. You have no prior health insurance policy.";
  const item = (over: Partial<ExceptionReviewItem>): ExceptionReviewItem => ({
    condition: "the claim arises from an accident",
    relevant: true,
    status: "not_established",
    basis_quote: null,
    ...over,
  });

  it("a not_established relevant exception is unresolved", () => {
    expect(firstUnresolvedException([item({})], [letter])?.condition).toMatch(/accident/);
  });

  it("an exception the letter explicitly rules out, with a verifiable quote, is resolved", () => {
    expect(
      firstUnresolvedException([item({ status: "does_not_apply", basis_quote: "was not caused by any accident" })], [letter])
    ).toBeNull();
  });

  it("an exception the user's answer establishes is resolved", () => {
    expect(
      firstUnresolvedException(
        [item({ status: "applies", basis_quote: "knocked off my motorcycle by a car" })],
        [letter, "I was knocked off my motorcycle by a car on 15 October."]
      )
    ).toBeNull();
  });

  it("'does not apply' WITHOUT a quote does not count (silence is not evidence)", () => {
    expect(firstUnresolvedException([item({ status: "does_not_apply", basis_quote: null })], [letter])).not.toBeNull();
    expect(firstUnresolvedException([item({ status: "does_not_apply", basis_quote: "  " })], [letter])).not.toBeNull();
  });

  it("a quote the model invented (not in the letter or answers) does not count", () => {
    expect(
      firstUnresolvedException([item({ status: "does_not_apply", basis_quote: "the insured confirmed there was no accident" })], [letter])
    ).not.toBeNull();
  });

  it("a quote whose meaning is flipped does not count", () => {
    expect(
      firstUnresolvedException([item({ status: "does_not_apply", basis_quote: "was caused by an accident which the insured reported" })], [letter])
    ).not.toBeNull();
  });

  it("irrelevant exceptions (about another item in the clause) never trigger a question", () => {
    expect(firstUnresolvedException([item({ relevant: false })], [letter])).toBeNull();
  });

  it("returns the first of several unresolved exceptions, skipping resolved ones", () => {
    const resolved = item({ condition: "no prior policy", status: "does_not_apply", basis_quote: "no prior health insurance policy" });
    const open = item({ condition: "the claim arises from an accident" });
    expect(firstUnresolvedException([resolved, open], [letter])?.condition).toBe("the claim arises from an accident");
  });

  it("matches a quote that differs from the source only by case, whitespace and quote style", () => {
    expect(
      firstUnresolvedException(
        [item({ status: "does_not_apply", basis_quote: "WAS NOT   CAUSED by any accident" })],
        [normalize(letter)]
      )
    ).toBeNull();
  });
});

describe("isNotSure", () => {
  it.each(["Not sure", "not sure", " Not sure. ", "NOT SURE"])("%j is not sure", (a) => expect(isNotSure(a)).toBe(true));
  it.each(["Yes", "No", "I am not sure whether it was an accident", "", undefined])("%j is not 'Not sure'", (a) => expect(isNotSure(a)).toBe(false));
});
