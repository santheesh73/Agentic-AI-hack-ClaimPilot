import { describe, it, expect } from "vitest";
import { decideVerdict, needsUserInput } from "../lib/agent/machine";
import type { Check } from "../lib/agent/schemas";

type Answer = "yes" | "no" | "unknown";
const ANSWERS: Answer[] = ["yes", "no", "unknown"];

function check(id: Check["id"], answer: Answer): Check {
  return { id, answer, rationale: "", evidence_refs: [] };
}

/**
 * Independent reference implementation of the verdict rule, written directly
 * in this test rather than imported from lib/agent/machine.ts, so this test
 * can't pass merely because it duplicates a bug in the code under test:
 *
 *   - C4 = yes -> WEAK (an explicit exclusion applies regardless of the cited clause)
 *   - C1 = yes AND C2 = yes AND C3 = no -> WEAK (the cited clause genuinely
 *     applies and nothing overrides it -- the insurer was right)
 *   - C1 = no, or C2 = no, or C3 = yes -> STRONG
 *   - otherwise -> ARGUABLE
 */
function referenceVerdict(c1: Answer, c2: Answer, c3: Answer, c4: Answer): "STRONG" | "ARGUABLE" | "WEAK" {
  if (c4 === "yes") return "WEAK";
  if (c1 === "yes" && c2 === "yes" && c3 === "no") return "WEAK";
  if (c1 === "no" || c2 === "no" || c3 === "yes") return "STRONG";
  return "ARGUABLE";
}

describe("decideVerdict: exhaustive truth table over C1-C4 (3^4 = 81 combinations)", () => {
  // C5 and C6 don't participate in decideVerdict at all (C5 instead gates the
  // separate AWAITING_USER decision below, and C6 is informational only), so
  // the real input space decideVerdict branches on is exactly these 81 cases
  // -- not 3^6, which would mostly vary dimensions the function ignores.
  for (const c1 of ANSWERS) {
    for (const c2 of ANSWERS) {
      for (const c3 of ANSWERS) {
        for (const c4 of ANSWERS) {
          it(`C1=${c1} C2=${c2} C3=${c3} C4=${c4}`, () => {
            const rubric: Check[] = [
              check("C1_CLAUSE_EXISTS", c1),
              check("C2_CONDITIONS_HOLD", c2),
              check("C3_OVERRIDING_CLAUSE", c3),
              check("C4_EXPLICIT_EXCLUSION", c4),
              check("C5_FACTS_KNOWN", "yes"),
              check("C6_DOCS_PRESENT", "yes"),
            ];
            expect(decideVerdict(rubric)).toBe(referenceVerdict(c1, c2, c3, c4));
          });
        }
      }
    }
  }
});

describe("needsUserInput: exhaustive over C5 x missing-facts presence (3*2 = 6 combinations)", () => {
  const cases: Array<[Answer, boolean, boolean]> = [
    ["yes", false, false],
    ["yes", true, false],
    ["no", false, false],
    ["no", true, true],
    ["unknown", false, false],
    ["unknown", true, true],
  ];
  for (const [c5, hasMissing, expected] of cases) {
    it(`C5=${c5}, hasUnresolvedMissingFacts=${hasMissing} -> ${expected}`, () => {
      expect(needsUserInput(c5, hasMissing)).toBe(expected);
    });
  }
});
