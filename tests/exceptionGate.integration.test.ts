// State-machine tests for "ask, don't assume on exception clauses":
// before a case can end as DONT_APPEAL, an exception clause behind the WEAK
// verdict that nothing establishes sends it to AWAITING_USER instead.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, resetFakeIds, type FakeDb } from "./helpers/fakeSupabase";
import { normalize } from "../lib/ingest/normalize";

let fakeDb: FakeDb;
const calls: Record<string, number> = {};
let script: Record<string, (n: number) => unknown>;

vi.mock("../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/db")>()),
  supabaseAdmin: () => createFakeSupabase(fakeDb),
}));
vi.mock("../lib/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/models")>()),
  generate: vi.fn(async ({ tool }: { tool: string }) => {
    calls[tool] = (calls[tool] ?? 0) + 1;
    const f = script[tool];
    if (!f) throw new Error(`no script for tool ${tool}`);
    return f(calls[tool]);
  }),
}));

const WITH_EXCEPTION =
  "Excl03 — Specified Disease/Procedure Waiting Period\n" +
  "Expenses related to the following listed conditions shall be excluded until the expiry of 24 months of continuous coverage:\n" +
  "cataract, hernia of all types, joint replacement surgery (unless due to accident), and fistula/fissure in ano.\n" +
  "Excl04 — Dental\nDental treatment is excluded.";
const NO_EXCEPTION =
  "Excl01 — Pre-Existing Diseases\n" +
  "Expenses related to the treatment of a pre-existing disease shall be excluded until the expiry of 48 months of continuous coverage after the date of inception of the first policy with the insurer.";
const QUOTE_EXC = "Expenses related to the following listed conditions shall be excluded until the expiry of 24 months of continuous coverage";
const QUOTE_NONE = "Expenses related to the treatment of a pre-existing disease shall be excluded until the expiry of 48 months of continuous coverage";
const LETTER_SILENT = "Your claim for total hip replacement is rejected under Excl03: you completed 13 months of continuous coverage.";
const LETTER_EXPLICIT = LETTER_SILENT + " Our medical review found the fracture resulted from osteoporosis and was not caused by any accident.";

const RUBRIC_WEAK = [
  { id: "C1_CLAUSE_EXISTS", answer: "yes", rationale: "r", evidence_refs: ["L1"] },
  { id: "C2_CONDITIONS_HOLD", answer: "yes", rationale: "r", evidence_refs: ["L1"] },
  { id: "C3_OVERRIDING_CLAUSE", answer: "no", rationale: "r", evidence_refs: [] },
  { id: "C4_EXPLICIT_EXCLUSION", answer: "no", rationale: "r", evidence_refs: [] },
  { id: "C5_FACTS_KNOWN", answer: "yes", rationale: "r", evidence_refs: [] },
  { id: "C6_DOCS_PRESENT", answer: "yes", rationale: "r", evidence_refs: [] },
];
const RUBRIC_STRONG = RUBRIC_WEAK.map((c) => (c.id === "C3_OVERRIDING_CLAUSE" ? { ...c, answer: "yes" } : c));

/** Seeds a case sitting at DECIDE with a provisional WEAK rubric whose evidence is a quote from `policyText`. */
function seed(policyText: string, quote: string, letter: string) {
  fakeDb = {
    cases: [{
      id: "c1", owner_id: "o", state: "DECIDE", answers: {}, missing_facts: [], rubric: RUBRIC_WEAK.map((c) => ({ ...c, evidence_refs: c.evidence_refs.map(() => "E1") })),
      candidate_page_ids: ["p-policy"], redraft_count: 0, redteam_done: false, sim_offset_days: 0, step_lock_until: null, verdict: null,
      facts: { insurer: "Ins", policy_no: null, claim_no: null, patient_name: null, claim_amount_inr: 320000, rejection_date: null, admission_date: null, policy_start_date: null, diagnosis: "hip fracture", reason_summary: "waiting period", clause_cited: "Excl03", reason_category: "waiting_period" },
    }],
    documents: [{ id: "d-policy", case_id: "c1", kind: "policy" }, { id: "d-rej", case_id: "c1", kind: "rejection" }],
    pages: [
      { id: "p-policy", document_id: "d-policy", case_id: "c1", page_no: 1, text: policyText, text_norm: normalize(policyText) },
      { id: "p-rej", document_id: "d-rej", case_id: "c1", page_no: 1, text: letter, text_norm: normalize(letter) },
    ],
    evidence: [{ id: "e1", case_id: "c1", short_id: "E1", claim: "waiting period", page_id: "p-policy", quote, verified: true, match_score: 1, source: "assess" }],
    agent_events: [], drafts: [], followups: [],
  } as FakeDb;
}

const review = (over: Record<string, unknown> = {}) => ({
  exceptions: [{ condition: "the hip replacement was needed because of an accident", relevant: true, status: "not_established", basis_quote: null }],
  question: "Was the hip replacement needed because of an accident?",
  ...over,
});

function baseScript(extra: Partial<typeof script> = {}) {
  script = {
    exception_review: () => review(),
    // The model's rubric follows the user's answer: a Yes (accident) overrides the exclusion.
    assess_case: () => ({
      checks: (fakeDb.cases[0].answers as Record<string, string>)?.exception_applies === "Yes" ? RUBRIC_STRONG : RUBRIC_WEAK,
      ledger: [{ temp_id: "L1", claim: "waiting period", page_id: "p-policy", quote: QUOTE_EXC }],
      missing_facts: [],
    }),
    choose_route: () => ({ reason: "r" }),
    dont_appeal_explanation: () => ({ explanation: "not advisable" }),
    draft_appeal: () => ({ subject: "Appeal", body_md: "The exclusion does not apply because the hip replacement followed an accident. [cite:E1]" }),
    redteam_review: () => ({ rebuttal: "ok", attacked: [], supporting: [], severity: "low" }),
    ...extra,
  };
}
const PAUSE = new Set(["AWAITING_USER", "AWAITING_APPROVAL", "DONT_APPEAL", "APPROVED", "ERROR"]);
async function runToPause(from: string) {
  const { runStep } = await import("../lib/agent/machine");
  let state = from;
  for (let i = 0; i < 25 && !(PAUSE.has(state) && i > 0); i++) {
    const r = await runStep("c1");
    state = r.state;
    if (PAUSE.has(state)) break;
  }
  return state;
}
const events = () => fakeDb.agent_events.map((e) => String(e.summary ?? ""));
const asked = () => events().filter((s) => s.startsWith("Exception clause found — asking instead of assuming"));

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  fakeDb = {};
  resetFakeIds();
  vi.clearAllMocks();
});

describe("exception gate before DONT_APPEAL", () => {
  it("asks one yes/no/not-sure question instead of assuming when the clause has an exception the letter is silent about", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    baseScript();
    expect(await runToPause("DECIDE")).toBe("AWAITING_USER");
    const c = fakeDb.cases[0];
    expect(c.verdict).toBeNull();
    expect(c.missing_facts).toEqual([
      { key: "exception_applies", question: "Was the hip replacement needed because of an accident?", options: ["Yes", "No", "Not sure"] },
    ]);
    expect(asked()).toHaveLength(1);
    expect(calls.dont_appeal_explanation ?? 0).toBe(0);
  });

  it("after a Yes answer it re-assesses and decides normally (appeal), without asking again", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    baseScript();
    await runToPause("DECIDE");
    const { recordAnswers } = await import("../lib/agent/machine");
    await recordAnswers("c1", { exception_applies: "Yes" });
    expect(fakeDb.cases[0].state).toBe("ASSESS");
    expect(await runToPause("ASSESS")).toBe("AWAITING_APPROVAL");
    expect(fakeDb.cases[0].verdict).toBe("STRONG");
    expect(calls.exception_review).toBe(1); // never asked twice
    expect(asked()).toHaveLength(1);
  });

  it("the re-assessment sees the answer together with its question", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    baseScript();
    await runToPause("DECIDE");
    const { recordAnswers, answersWithQuestions } = await import("../lib/agent/machine");
    await recordAnswers("c1", { exception_applies: "Yes" });
    expect(answersWithQuestions(fakeDb.cases[0] as never)).toEqual({
      exception_applies: "Was the hip replacement needed because of an accident? — Yes",
    });
  });

  it("after a No answer the verdict stays WEAK and the case ends as DONT_APPEAL without asking again", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    baseScript({ assess_case: () => ({ checks: RUBRIC_WEAK, ledger: [{ temp_id: "L1", claim: "c", page_id: "p-policy", quote: QUOTE_EXC }], missing_facts: [] }) });
    await runToPause("DECIDE");
    const { recordAnswers } = await import("../lib/agent/machine");
    await recordAnswers("c1", { exception_applies: "No" });
    expect(await runToPause("ASSESS")).toBe("DONT_APPEAL");
    expect(fakeDb.cases[0].verdict).toBe("WEAK");
    expect(calls.exception_review).toBe(1);
    expect(asked()).toHaveLength(1);
  });

  it("'Not sure' never ends as WEAK: the verdict becomes ARGUABLE and the case proceeds to a letter", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    baseScript({ assess_case: () => ({ checks: RUBRIC_WEAK, ledger: [{ temp_id: "L1", claim: "c", page_id: "p-policy", quote: QUOTE_EXC }], missing_facts: [] }) });
    await runToPause("DECIDE");
    const { recordAnswers } = await import("../lib/agent/machine");
    await recordAnswers("c1", { exception_applies: "Not sure" });
    const final = await runToPause("ASSESS");
    expect(fakeDb.cases[0].verdict).toBe("ARGUABLE");
    expect(final).toBe("AWAITING_APPROVAL");
    expect(calls.dont_appeal_explanation ?? 0).toBe(0);
  });

  it("a clause with NO exception goes straight to DONT_APPEAL: no extra question, no review call", async () => {
    seed(NO_EXCEPTION, QUOTE_NONE, LETTER_SILENT);
    baseScript();
    expect(await runToPause("DECIDE")).toBe("DONT_APPEAL");
    expect(fakeDb.cases[0].verdict).toBe("WEAK");
    expect(calls.exception_review ?? 0).toBe(0);
    expect(asked()).toHaveLength(0);
    expect(fakeDb.cases[0].missing_facts).toEqual([]);
  });

  it("the exception in a DIFFERENT clause on the same page does not trigger a question", async () => {
    seed(WITH_EXCEPTION, "Dental treatment is excluded", LETTER_SILENT);
    fakeDb.evidence[0].quote = "Dental treatment is excluded";
    baseScript();
    expect(await runToPause("DECIDE")).toBe("DONT_APPEAL");
    expect(calls.exception_review ?? 0).toBe(0);
  });

  it("does not ask when the letter explicitly rules the exception out, backed by a verifiable quote", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_EXPLICIT);
    baseScript({ exception_review: () => review({ exceptions: [{ condition: "the hip replacement was needed because of an accident", relevant: true, status: "does_not_apply", basis_quote: "was not caused by any accident" }], question: null }) });
    expect(await runToPause("DECIDE")).toBe("DONT_APPEAL");
    expect(calls.exception_review).toBe(1);
    expect(asked()).toHaveLength(0);
  });

  it("asks anyway when the model claims the exception doesn't apply but its quote is not in the letter or answers", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    baseScript({ exception_review: () => review({ exceptions: [{ condition: "accident", relevant: true, status: "does_not_apply", basis_quote: "the facts do not indicate an accident" }] }) });
    expect(await runToPause("DECIDE")).toBe("AWAITING_USER");
  });

  it("does not ask about an exception that concerns a different item in the clause", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    baseScript({ exception_review: () => review({ exceptions: [{ condition: "accident", relevant: false, status: "not_established", basis_quote: null }], question: null }) });
    expect(await runToPause("DECIDE")).toBe("DONT_APPEAL");
  });

  it("falls back to a generic question if the model returns none", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    baseScript({ exception_review: () => review({ question: null }) });
    await runToPause("DECIDE");
    expect((fakeDb.cases[0].missing_facts as Array<{ question: string }>)[0].question).toMatch(/^Does this apply to your claim: .*accident/);
  });

  it("a STRONG or ARGUABLE verdict never runs the exception check", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    fakeDb.cases[0].rubric = RUBRIC_STRONG;
    baseScript();
    await runToPause("DECIDE");
    expect(calls.exception_review ?? 0).toBe(0);
  });

  it("when C4 (explicit exclusion) drove the verdict, the check looks at C4's evidence", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    fakeDb.cases[0].rubric = RUBRIC_WEAK.map((c) =>
      c.id === "C4_EXPLICIT_EXCLUSION" ? { ...c, answer: "yes", evidence_refs: ["E2"] } : { ...c, answer: c.id === "C3_OVERRIDING_CLAUSE" ? "yes" : c.answer, evidence_refs: ["E1"] }
    );
    // E1's clause has the exception; E2 (the driver) is the no-exception clause
    (fakeDb.pages as Array<Record<string, unknown>>).push({ id: "p2", document_id: "d-policy", case_id: "c1", page_no: 2, text: NO_EXCEPTION, text_norm: normalize(NO_EXCEPTION) });
    (fakeDb.evidence as Array<Record<string, unknown>>).push({ id: "e2", case_id: "c1", short_id: "E2", claim: "x", page_id: "p2", quote: QUOTE_NONE, verified: true, match_score: 1, source: "assess" });
    baseScript();
    expect(await runToPause("DECIDE")).toBe("DONT_APPEAL");
    expect(calls.exception_review ?? 0).toBe(0);
  });

  it("an already-answered exception question is never asked again, even if the letter is still silent", async () => {
    seed(WITH_EXCEPTION, QUOTE_EXC, LETTER_SILENT);
    fakeDb.cases[0].answers = { exception_applies: "No" };
    baseScript();
    expect(await runToPause("DECIDE")).toBe("DONT_APPEAL");
    expect(calls.exception_review ?? 0).toBe(0);
  });
});
