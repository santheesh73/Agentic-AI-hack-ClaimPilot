import { describe, it, expect } from "vitest";
import { scheduleFollowups, chooseRoute, isOmbudsmanEligibleByAmount, simNow, deadlinesForUi } from "../lib/agent/deadlines";

const SEEDED_RULE_IDS = new Set(["GRO_14D", "BIMA_BHAROSA", "OMB_ELIGIBLE", "OMB_1YEAR", "OMB_CAP"]);

describe("chooseRoute", () => {
  it("always routes to the insurer GRO first", () => {
    expect(chooseRoute("Acme Health")).toEqual({
      step: "insurer_gro",
      addressee: "Grievance Redressal Officer, Acme Health",
    });
  });
});

describe("scheduleFollowups", () => {
  it("adds 14 days for the Bima Bharosa escalation", () => {
    const fu = scheduleFollowups("2026-01-01", 200000);
    const bb = fu.find((f) => f.action === "ESCALATE_BIMA_BHAROSA");
    expect(bb?.due_on).toBe("2026-01-15");
  });

  it("adds 1 calendar month for Ombudsman eligibility", () => {
    const fu = scheduleFollowups("2026-01-01", 200000);
    const elig = fu.find((f) => f.action === "OMBUDSMAN_ELIGIBLE");
    expect(elig?.due_on).toBe("2026-02-01");
  });

  it("handles Jan 31 + 1 month by clamping to Feb 28 (non-leap year)", () => {
    const fu = scheduleFollowups("2027-01-31", 200000);
    const elig = fu.find((f) => f.action === "OMBUDSMAN_ELIGIBLE");
    expect(elig?.due_on).toBe("2027-02-28");
  });

  it("handles Jan 31 + 1 month in a leap year by clamping to Feb 29", () => {
    const fu = scheduleFollowups("2028-01-31", 200000);
    const elig = fu.find((f) => f.action === "OMBUDSMAN_ELIGIBLE");
    expect(elig?.due_on).toBe("2028-02-29");
  });

  it("sets the Ombudsman last date to 1 month + 1 year out", () => {
    const fu = scheduleFollowups("2026-01-01", 200000);
    const last = fu.find((f) => f.action === "OMBUDSMAN_LAST_DATE");
    expect(last?.due_on).toBe("2027-02-01");
  });

  it("flags Ombudsman ineligibility above the Rs 50 lakh cap", () => {
    const fu = scheduleFollowups("2026-01-01", 6_000_000);
    expect(fu.some((f) => f.action === "OMBUDSMAN_INELIGIBLE_CAP")).toBe(true);
  });

  it("does not flag ineligibility at or below the cap", () => {
    const fu = scheduleFollowups("2026-01-01", 5_000_000);
    expect(fu.some((f) => f.action === "OMBUDSMAN_INELIGIBLE_CAP")).toBe(false);
  });

  it("handles a year-end rollover (Dec 31 + 1 month -> Jan 31 next year)", () => {
    const fu = scheduleFollowups("2026-12-31", 200000);
    const elig = fu.find((f) => f.action === "OMBUDSMAN_ELIGIBLE");
    expect(elig?.due_on).toBe("2027-01-31");
  });

  it("handles a leap day (Feb 29 + 1 month -> Mar 29, no clamping needed)", () => {
    const fu = scheduleFollowups("2028-02-29", 200000);
    const elig = fu.find((f) => f.action === "OMBUDSMAN_ELIGIBLE");
    expect(elig?.due_on).toBe("2028-03-29");
  });

  it("every rule_id it produces exists in the regulations seed data (supabase/migrations/0001_init.sql)", () => {
    const fu = scheduleFollowups("2026-01-01", 6_000_000); // over the cap, so all 4 rule_ids appear
    for (const f of fu) {
      expect(SEEDED_RULE_IDS.has(f.rule_id)).toBe(true);
    }
    expect(fu.length).toBeGreaterThan(0);
  });
});

describe("deadlinesForUi", () => {
  it("returns nothing before a complaint has been sent", () => {
    expect(deadlinesForUi(null, 200000)).toEqual([]);
  });

  it("every deadline's rule_id exists in the regulations seed data", () => {
    const deadlines = deadlinesForUi("2026-01-01", 6_000_000);
    expect(deadlines.length).toBeGreaterThan(0);
    for (const d of deadlines) {
      expect(SEEDED_RULE_IDS.has(d.rule_id)).toBe(true);
      expect(d.source_url).toMatch(/^https:\/\//);
    }
  });
});

describe("isOmbudsmanEligibleByAmount", () => {
  it("is eligible when amount is null (unknown)", () => {
    expect(isOmbudsmanEligibleByAmount(null)).toBe(true);
  });
  it("is eligible at exactly the cap", () => {
    expect(isOmbudsmanEligibleByAmount(5_000_000)).toBe(true);
  });
  it("is ineligible above the cap", () => {
    expect(isOmbudsmanEligibleByAmount(5_000_001)).toBe(false);
  });
});

describe("simNow", () => {
  it("adds the sim offset to the given date", () => {
    expect(simNow(15, new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-16");
  });
  it("defaults to 0 offset producing today", () => {
    expect(simNow(0, new Date("2026-03-10T12:00:00Z"))).toBe("2026-03-10");
  });
});
