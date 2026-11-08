import { it } from "vitest";
import fs from "node:fs";
import { scheduleFollowups, deadlinesForUi, simNow, isOmbudsmanEligibleByAmount } from "@/lib/agent/deadlines";

it("deadline engine edge cases", () => {
  const seed = fs.readFileSync("supabase/migrations/0001_init.sql", "utf8");
  const seedIds = [...seed.matchAll(/\('([A-Z_0-9]+)','(insurer_gro|irdai_bima_bharosa|ombudsman)'/g)].map((m) => m[1]);
  const cases: Record<string, unknown> = {};
  for (const d of ["2026-01-31", "2028-02-29", "2027-12-20", "2026-12-31", "2026-03-31"]) cases[d] = scheduleFollowups(d, 100000);
  const usedRuleIds = new Set<string>();
  for (const amt of [null, 0, 4_999_999, 5_000_000, 5_000_001]) scheduleFollowups("2026-01-01", amt).forEach((f) => usedRuleIds.add(f.rule_id));
  const ui = deadlinesForUi("2026-01-01", 6_000_000);
  // simNow at 23:00 UTC = 04:30 IST next day: what date is recorded?
  const t = new Date("2026-03-31T23:00:00Z");
  const report = {
    by_sent_date: cases,
    cap_boundary: { "50 lakh exactly eligible": isOmbudsmanEligibleByAmount(5_000_000), "50 lakh + 1 eligible": isOmbudsmanEligibleByAmount(5_000_001),
      followups_at_5000000: scheduleFollowups("2026-01-01", 5_000_000).map((f) => f.action), followups_at_5000001: scheduleFollowups("2026-01-01", 5_000_001).map((f) => f.action) },
    ui_over_cap_labels: ui.map((d) => d.label),
    rule_ids_used: [...usedRuleIds], rule_ids_in_seed: seedIds, missing_from_seed: [...usedRuleIds].filter((r) => !seedIds.includes(r)),
    timezone: { instant_utc: t.toISOString(), ist_local_date: "2026-04-01", simNow_returns: simNow(0, t) },
    simulate_offset: { "simNow(15) from 2026-12-20": simNow(15, new Date("2026-12-20T10:00:00Z")), "simNow(-1)": simNow(-1, new Date("2026-01-01T10:00:00Z")) },
    seed_clock_days: { OMB_ELIGIBLE_seed_days: 30, code_uses: "addCalendarMonths(+1)" },
  };
  fs.writeFileSync("audit/logs/25-deadlines.json", JSON.stringify(report, null, 2));
});
