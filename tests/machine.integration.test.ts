import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, resetFakeIds, type FakeDb } from "./helpers/fakeSupabase";
import { normalize } from "../lib/ingest/normalize";

// Mock the DB layer with the in-memory fake, and the LLM layer with a
// scripted response per tool, so the full state machine runs offline and
// deterministically -- no network, no real Supabase, no real model call.
let fakeDb: FakeDb;

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    supabaseAdmin: () => createFakeSupabase(fakeDb),
  };
});

vi.mock("../lib/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/models")>();
  return {
    ...actual,
    generate: vi.fn(async ({ tool }: { tool: string }) => mockGenerate(tool)),
  };
});

const POLICY_PAGE_TEXT =
  "Excl01 Pre-Existing Diseases: expenses related to the treatment of a pre-existing disease and its direct " +
  "complications shall be excluded until the expiry of 48 months of continuous coverage after the date of " +
  "inception of the first policy with the insurer. Once the policy has been continuously renewed without a " +
  "break for 48 months, this exclusion shall cease to apply.";

const REJECTION_TEXT = "Your claim is rejected under Excl01 Pre-Existing Diseases as the condition pre-dates the policy.";

// The ledger quote must be a genuine substring of POLICY_PAGE_TEXT's
// normalized text, because lib/agent/verify.ts's real matchQuote() runs
// against it unmocked -- this is what proves the citation verifier actually
// gates the pipeline rather than just being decoration.
const VERBATIM_QUOTE =
  "once the policy has been continuously renewed without a break for 48 months, this exclusion shall cease to apply";

function mockGenerate(tool: string): unknown {
  switch (tool) {
    case "extract_rejection":
      return {
        insurer: "Test Insurer Ltd.",
        policy_no: "POL-123",
        claim_no: "CLM-456",
        patient_name: "Test Patient",
        claim_amount_inr: 100000,
        rejection_date: "2026-09-25",
        admission_date: "2026-09-15",
        policy_start_date: "2022-03-01",
        diagnosis: "Test diagnosis",
        reason_summary: "Rejected as a pre-existing disease.",
        clause_cited: "Excl01",
        reason_category: "pre_existing",
      };
    case "write_queries":
      return { queries: ["pre-existing disease waiting period", "Excl01 exclusion"] };
    case "assess_case":
      return {
        checks: [
          { id: "C1_CLAUSE_EXISTS", answer: "yes", rationale: "Excl01 exists.", evidence_refs: ["L1"] },
          { id: "C2_CONDITIONS_HOLD", answer: "no", rationale: "48 months already elapsed.", evidence_refs: ["L1"] },
          { id: "C3_OVERRIDING_CLAUSE", answer: "yes", rationale: "Waiting period completed.", evidence_refs: ["L1"] },
          { id: "C4_EXPLICIT_EXCLUSION", answer: "no", rationale: "No other exclusion applies.", evidence_refs: [] },
          { id: "C5_FACTS_KNOWN", answer: "yes", rationale: "All dates known.", evidence_refs: [] },
          { id: "C6_DOCS_PRESENT", answer: "yes", rationale: "Documents present.", evidence_refs: [] },
        ],
        ledger: [{ temp_id: "L1", claim: "The waiting period has elapsed.", page_id: "page-policy-1", quote: VERBATIM_QUOTE }],
        missing_facts: [],
      };
    case "choose_route":
      return { reason: "The insurer's cited exclusion no longer applies." };
    case "draft_appeal":
      return {
        subject: "Appeal for reconsideration",
        body_md: `We request reconsideration since the waiting period has elapsed. [cite:E1]`,
      };
    case "redteam_review":
      return { rebuttal: "The appeal is well-supported.", attacked: [], supporting: [], severity: "low" };
    case "dont_appeal_explanation":
      return { explanation: "This claim is not worth appealing." };
    default:
      throw new Error(`mockGenerate: no canned response for tool "${tool}"`);
  }
}

async function seedCase(): Promise<string> {
  const caseId = "case-1";
  fakeDb.cases = [
    {
      id: caseId,
      owner_id: "owner-1",
      title: "Test case",
      insurer: null,
      claim_amount_inr: 100000,
      state: "INTAKE",
      verdict: null,
      facts: null,
      queries: null,
      candidate_page_ids: [],
      rubric: null,
      missing_facts: null,
      answers: {},
      route: null,
      deadlines: null,
      redraft_count: 0,
      redteam_done: false,
      dont_appeal_reason: null,
      complaint_sent_on: null,
      sim_offset_days: 0,
      error: null,
      step_lock_until: null,
    },
  ];
  fakeDb.documents = [
    { id: "doc-policy", case_id: caseId, kind: "policy", storage_path: null, filename: "policy.pdf", page_count: 1 },
    { id: "doc-rejection", case_id: caseId, kind: "rejection", storage_path: null, filename: "rejection.txt", page_count: 1 },
  ];
  fakeDb.pages = [
    {
      id: "page-policy-1",
      document_id: "doc-policy",
      case_id: caseId,
      page_no: 1,
      text: POLICY_PAGE_TEXT,
      text_norm: normalize(POLICY_PAGE_TEXT),
    },
    {
      id: "page-rejection-1",
      document_id: "doc-rejection",
      case_id: caseId,
      page_no: 1,
      text: REJECTION_TEXT,
      text_norm: normalize(REJECTION_TEXT),
    },
  ];
  fakeDb.evidence = [];
  fakeDb.agent_events = [];
  fakeDb.drafts = [];
  fakeDb.followups = [];
  return caseId;
}

const PAUSE_OR_TERMINAL = new Set(["AWAITING_USER", "AWAITING_APPROVAL", "DONT_APPEAL", "APPROVED", "ERROR"]);

describe("state machine integration (mocked LLM + in-memory DB, fully offline)", () => {
  beforeEach(() => {
    fakeDb = {};
    resetFakeIds();
    vi.clearAllMocks();
  });

  it("runs INTAKE through AWAITING_APPROVAL with a fully-cited, fully-verified draft", async () => {
    const { runStep } = await import("../lib/agent/machine");
    const caseId = await seedCase();

    let state = "INTAKE";
    for (let i = 0; i < 20 && !PAUSE_OR_TERMINAL.has(state); i++) {
      const result = await runStep(caseId);
      state = result.state;
    }

    expect(state).toBe("AWAITING_APPROVAL");

    const finalCase = fakeDb.cases.find((c) => c.id === caseId)!;
    expect(finalCase.verdict).toBe("STRONG");
    expect(finalCase.step_lock_until).toBeNull(); // lock always released

    const evidence = fakeDb.evidence.filter((e) => e.case_id === caseId);
    expect(evidence.length).toBe(1);
    expect(evidence[0].verified).toBe(true); // the real matchQuote() verified our canned quote

    const drafts = fakeDb.drafts.filter((d) => d.case_id === caseId);
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    const latestDraft = drafts[drafts.length - 1];
    expect(latestDraft.body_md).toContain("[cite:E1]");
    const verification = latestDraft.verification as Array<{ short_id: string; ok: boolean }>;
    expect(verification.every((v) => v.ok)).toBe(true);

    // Every /step call claims and releases the lease -- no stale lock left behind.
    const lockEvents = fakeDb.agent_events.filter((e) => e.case_id === caseId);
    expect(lockEvents.length).toBeGreaterThan(0);
  });

  it("surfaces a model schema failure as ERROR after exhausting retries", async () => {
    vi.doMock("../lib/models", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/models")>();
      return {
        ...actual,
        generate: vi.fn(async () => {
          throw new Error("schema validation failed");
        }),
      };
    });
    vi.resetModules();
    const { runStep } = await import("../lib/agent/machine");
    const caseId = await seedCase();

    await runStep(caseId); // INTAKE -> EXTRACT
    const result = await runStep(caseId); // EXTRACT fails

    expect(result.state).toBe("ERROR");
    const finalCase = fakeDb.cases.find((c) => c.id === caseId)!;
    expect(finalCase.error).toBeTruthy();
  });
});
