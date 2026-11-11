import { describe, it, expect } from "vitest";
import { scheduleFollowups, chooseRoute, isOmbudsmanEligibleByAmount, simNow, deadlinesForUi, ombudsmanLastDate } from "../lib/agent/deadlines";

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
    const fu = [...scheduleFollowups("2026-01-01", 6_000_000), ...scheduleFollowups("2026-01-01", 100), ...scheduleFollowups("2026-01-01", 100, "2026-01-10")];
    for (const f of fu) {
      expect(SEEDED_RULE_IDS.has(f.rule_id)).toBe(true);
    }
    expect(fu.length).toBeGreaterThan(0);
  });
});

// --- Regression tests for audit findings F-003 and F-008 ---
describe("Ombudsman cap and last date", () => {
  it("above the cap: no eligible/last-date rows, only 'not available' (F-008)", () => {
    const actions = scheduleFollowups("2026-01-01", 5_000_001).map((f) => f.action);
    expect(actions).toEqual(["ESCALATE_BIMA_BHAROSA", "OMBUDSMAN_INELIGIBLE_CAP"]);
  });
  it("at exactly 50 lakh: eligible, and no 'not available' row", () => {
    const actions = scheduleFollowups("2026-01-01", 5_000_000).map((f) => f.action);
    expect(actions).toEqual(["ESCALATE_BIMA_BHAROSA", "OMBUDSMAN_ELIGIBLE", "OMBUDSMAN_LAST_DATE"]);
  });
  it("isOmbudsmanEligibleByAmount: unknown amount and the cap itself are eligible, cap + 1 is not", () => {
    expect(isOmbudsmanEligibleByAmount(null)).toBe(true);
    expect(isOmbudsmanEligibleByAmount(5_000_000)).toBe(true);
    expect(isOmbudsmanEligibleByAmount(5_000_001)).toBe(false);
  });
  it("last date with no reply is sent + 1 month + 1 year (F-003)", () => {
    expect(ombudsmanLastDate("2026-01-31")).toBe("2027-02-28");
  });
  it("a reply makes the deadline 1 year from the reply, which is earlier (F-003)", () => {
    expect(ombudsmanLastDate("2026-01-31", "2026-02-10")).toBe("2027-02-10");
    const fu = scheduleFollowups("2026-01-31", 100000, "2026-02-10");
    expect(fu.find((f) => f.rule_id === "OMB_1YEAR")).toMatchObject({ action: "OMBUDSMAN_LAST_DATE_AFTER_REPLY", due_on: "2027-02-10" });
  });
  it("a reply after the no-reply period cannot extend the deadline", () => {
    expect(ombudsmanLastDate("2026-01-01", "2026-06-01")).toBe("2027-02-01");
  });
  it("the no-reply last date is labelled as conditional, never as unconditional (F-003)", () => {
    const row = deadlinesForUi("2026-01-01", 100000).find((d) => d.rule_id === "OMB_1YEAR")!;
    expect(row.label).toMatch(/if the insurer does not reply/i);
    expect(row.label).toMatch(/1 year from their reply/i);
  });
  it("every row has a human label and a source url", () => {
    for (const d of [...deadlinesForUi("2026-01-01", 100000), ...deadlinesForUi("2026-01-01", 9_000_000), ...deadlinesForUi("2026-01-01", 1, "2026-01-05")]) {
      expect(d.label).not.toMatch(/^[A-Z_]+$/);
      expect(d.source_url).toMatch(/^https:\/\//);
    }
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

// Audit F-015: the complaint date is the calendar date in India, not in UTC.
describe("simNow uses the IST calendar date", () => {
  it("23:00 UTC is already the next day in India", () => {
    expect(simNow(0, new Date("2026-03-31T23:00:00Z"))).toBe("2026-04-01");
  });
  it("18:29 UTC is still the same day in India; 18:30 UTC is the next", () => {
    expect(simNow(0, new Date("2026-03-31T18:29:00Z"))).toBe("2026-03-31");
    expect(simNow(0, new Date("2026-03-31T18:30:00Z"))).toBe("2026-04-01");
  });
  it("adds the simulation offset to the IST date", () => {
    expect(simNow(15, new Date("2026-12-20T23:00:00Z"))).toBe("2027-01-05");
  });
});
