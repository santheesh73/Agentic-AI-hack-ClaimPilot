import { describe, it, expect } from "vitest";
import { addMonthsIso, waitingPeriodExpired, reconcileWaitingPeriod } from "../lib/agent/waitingPeriod";
import type { Check } from "../lib/agent/schemas";

const wp = (over: Record<string, unknown> = {}) => ({
  applies: true, months: 48, start_date: "2022-03-01", admission_date: "2026-09-15", ...over,
}) as never;

const checks = (c2: Check["answer"]): Check[] => [
  { id: "C1_CLAUSE_EXISTS", answer: "yes", rationale: "r", evidence_refs: [] },
  { id: "C2_CONDITIONS_HOLD", answer: c2, rationale: "Policy start 2022-03-01 + 48 months = 2026-03-01 < admission.", evidence_refs: [] },
  { id: "C3_OVERRIDING_CLAUSE", answer: "no", rationale: "r", evidence_refs: [] },
  { id: "C4_EXPLICIT_EXCLUSION", answer: "no", rationale: "r", evidence_refs: [] },
  { id: "C5_FACTS_KNOWN", answer: "yes", rationale: "r", evidence_refs: [] },
  { id: "C6_DOCS_PRESENT", answer: "yes", rationale: "r", evidence_refs: [] },
];

describe("addMonthsIso", () => {
  it("adds whole months", () => {
    expect(addMonthsIso("2022-03-01", 48)).toBe("2026-03-01");
    expect(addMonthsIso("2023-01-10", 24)).toBe("2025-01-10");
    expect(addMonthsIso("2025-11-15", 3)).toBe("2026-02-15");
  });
  it("clamps to the last day of a shorter month", () => {
    expect(addMonthsIso("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonthsIso("2023-01-31", 1)).toBe("2023-02-28");
    expect(addMonthsIso("2024-02-29", 12)).toBe("2025-02-28");
  });
  it("rejects malformed input", () => {
    expect(addMonthsIso("01/03/2022", 24)).toBeNull();
    expect(addMonthsIso("2022-13-01", 24)).toBeNull();
    expect(addMonthsIso("2022-03-01", -1)).toBeNull();
    expect(addMonthsIso("2022-03-01", 1.5)).toBeNull();
  });
});

describe("waitingPeriodExpired", () => {
  it("is true when the period ended before admission, false when after", () => {
    expect(waitingPeriodExpired(wp())).toBe(true);
    expect(waitingPeriodExpired(wp({ admission_date: "2025-01-01" }))).toBe(false);
  });
  it("counts a period that ends exactly on the admission date as completed", () => {
    expect(waitingPeriodExpired(wp({ admission_date: "2026-03-01" }))).toBe(true);
    expect(waitingPeriodExpired(wp({ admission_date: "2026-02-28" }))).toBe(false);
  });
  it("is null (unknown) when it cannot be computed", () => {
    expect(waitingPeriodExpired(null)).toBeNull();
    expect(waitingPeriodExpired(undefined)).toBeNull();
    expect(waitingPeriodExpired(wp({ applies: false }))).toBeNull();
    expect(waitingPeriodExpired(wp({ months: null }))).toBeNull();
    expect(waitingPeriodExpired(wp({ start_date: null }))).toBeNull();
    expect(waitingPeriodExpired(wp({ admission_date: "soon" }))).toBeNull();
  });
});

describe("reconcileWaitingPeriod", () => {
  it("corrects C2 yes -> no when the computed waiting period had expired (case A)", () => {
    const { checks: out, corrected } = reconcileWaitingPeriod(checks("yes"), wp());
    const c2 = out.find((c) => c.id === "C2_CONDITIONS_HOLD")!;
    expect(c2.answer).toBe("no");
    expect(c2.rationale).toContain("Corrected by code: 2022-03-01 + 48 months = 2026-03-01");
    expect(corrected).toContain("2026-09-15");
    // nothing else is touched
    expect(out.filter((c) => c.id !== "C2_CONDITIONS_HOLD")).toEqual(checks("yes").filter((c) => c.id !== "C2_CONDITIONS_HOLD"));
  });
  it("leaves a correct answer alone", () => {
    const input = checks("no");
    expect(reconcileWaitingPeriod(input, wp())).toEqual({ checks: input, corrected: null });
  });
  it("never turns a no into a yes, and leaves a still-running period alone", () => {
    const running = wp({ admission_date: "2025-01-01" });
    expect(reconcileWaitingPeriod(checks("yes"), running).corrected).toBeNull();
    expect(reconcileWaitingPeriod(checks("no"), running).checks).toEqual(checks("no"));
  });
  it("does nothing without usable waiting-period facts", () => {
    expect(reconcileWaitingPeriod(checks("yes"), null).corrected).toBeNull();
    expect(reconcileWaitingPeriod(checks("yes"), wp({ applies: false })).corrected).toBeNull();
  });
});
