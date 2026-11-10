import { describe, it, expect, vi } from "vitest";

// Audit/eval finding (case L): the assessment step only saw a short extracted
// summary, so facts the insurer states in the letter were invisible to it and
// were reported as "unknown". The letter must reach the model.
const generate = vi.fn();
generate.mockResolvedValue({ checks: [], ledger: [], missing_facts: [] });
vi.mock("../lib/models", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/models")>()), generate }));

const FACTS = {
  insurer: "Ins", policy_no: null, claim_no: null, patient_name: null, claim_amount_inr: 1, rejection_date: null,
  admission_date: null, policy_start_date: null, diagnosis: "asthma", reason_summary: "non-disclosure",
  clause_cited: "Clause 6.2", reason_category: "non_disclosure" as const,
};

describe("assessCase prompt", () => {
  it("includes the full rejection letter, wrapped as an untrusted document", async () => {
    const { assessCase } = await import("../lib/agent/tools/assessCase");
    const letter = "Our investigation found a pulmonologist's prescription dated 14 March 2023. The proposal form answered 'No'.";
    await assessCase("c1", FACTS, [{ id: "p1", page_no: 3, text: "6.3 A condition first diagnosed on or after..." }], {}, letter);
    const args = generate.mock.calls[0][0] as { system: string; prompt: Array<{ text: string }> };
    const prompt = args.prompt.map((p) => p.text).join("\n");
    expect(prompt).toContain("prescription dated 14 March 2023");
    expect(prompt).toContain("proposal form answered 'No'");
    expect(prompt).toMatch(/<document kind="rejection" citable="false">/);
    // nothing citable: no page_id on the letter (that made the model cite it and fail the ledger schema)
    expect(prompt.match(/<document kind="rejection"[^>]*>/)![0]).not.toMatch(/page_id/);
    expect(prompt).toContain("Rejection facts:");
  });

  it("tells the model the letter is not citable evidence", async () => {
    const { ASSESS_CASE_SYSTEM } = await import("../lib/agent/prompts");
    expect(ASSESS_CASE_SYSTEM).toMatch(/NOT citable evidence/);
  });

  it("tells the model that facts stated in the letter are known, not unknown", async () => {
    const { ASSESS_CASE_SYSTEM } = await import("../lib/agent/prompts");
    expect(ASSESS_CASE_SYSTEM).toMatch(/states in it .* are known facts/i);
    expect(ASSESS_CASE_SYSTEM).toMatch(/Do not mark a fact "unknown" when the letter states it/);
  });
});
