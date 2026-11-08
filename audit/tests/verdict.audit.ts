// Independent reference of the §2 design rules vs the shipped code, over all
// 3^6 = 729 rubric combinations x {missing facts unanswered: yes/no}.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { decideVerdict, needsUserInput } from "@/lib/agent/machine";

type A = "yes" | "no" | "unknown";
const VALS: A[] = ["yes", "no", "unknown"];
const IDS = ["C1_CLAUSE_EXISTS", "C2_CONDITIONS_HOLD", "C3_OVERRIDING_CLAUSE", "C4_EXPLICIT_EXCLUSION", "C5_FACTS_KNOWN", "C6_DOCS_PRESENT"] as const;

// §2, literally: C4=yes -> WEAK; else C1=no|C2=no|C3=yes -> STRONG;
// else if facts missing & unanswered -> ASK; else ARGUABLE.
function designReference(c: A[], missingUnanswered: boolean): string {
  const [c1, c2, c3, c4] = c;
  if (c4 === "yes") return "WEAK";
  if (c1 === "no" || c2 === "no" || c3 === "yes") return "STRONG";
  if (missingUnanswered) return "ASK";
  return "ARGUABLE";
}

// What the shipped pipeline does end to end: ASSESS asks first (needsUserInput),
// otherwise DECIDE applies decideVerdict.
function shipped(c: A[], missingUnanswered: boolean): string {
  const rubric = IDS.map((id, i) => ({ id, answer: c[i], rationale: "", evidence_refs: [] }));
  const verdict = decideVerdict(rubric as never);
  if (needsUserInput(verdict, c[4], missingUnanswered)) return "ASK";
  return verdict;
}

describe("verdict logic vs §2 design", () => {
  it("enumerates all combinations and records mismatches", () => {
    const rows: Array<Record<string, unknown>> = [];
    let total = 0;
    for (let n = 0; n < 729; n++) {
      const c = IDS.map((_, i) => VALS[Math.floor(n / 3 ** i) % 3]);
      for (const missing of [false, true]) {
        total++;
        const want = designReference(c, missing), got = shipped(c, missing);
        if (want !== got) rows.push({ C1: c[0], C2: c[1], C3: c[2], C4: c[3], C5: c[4], C6: c[5], missing, design: want, code: got });
      }
    }
    // Group mismatches by (design -> code) pattern for the report.
    const groups: Record<string, number> = {};
    for (const r of rows) groups[`${r.design} -> ${r.code}`] = (groups[`${r.design} -> ${r.code}`] ?? 0) + 1;
    // C6 never affects the code's output: check it independently.
    let c6Matters = 0;
    for (let n = 0; n < 243; n++) {
      const base = IDS.slice(0, 5).map((_, i) => VALS[Math.floor(n / 3 ** i) % 3]);
      const outs = new Set(VALS.map((v6) => shipped([...base, v6], false)));
      if (outs.size > 1) c6Matters++;
    }
    const report = { total, mismatches: rows.length, groups, c6_changes_outcome_in: c6Matters, examples: rows.slice(0, 12) };
    fs.writeFileSync("audit/logs/20-verdict-729.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ total, mismatches: rows.length, groups, c6Matters }, null, 1));
    expect(total).toBe(1458);
  });
});
