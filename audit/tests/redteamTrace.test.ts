import { it, vi } from "vitest";
import fs from "node:fs";
import { makeClient, type Db } from "./auditFakeDb";
let db: Db; const calls: Record<string, number> = {};
vi.mock("@/lib/db", () => ({ supabaseAdmin: () => makeClient(db), getOwnerId: async () => "o", getOrCreateOwnerId: async () => "o", DOCUMENTS_BUCKET: "documents" }));
vi.mock("@/lib/models", async (orig) => ({ ...(await orig<any>()), generate: vi.fn(async ({ tool }: any) => { calls[tool] = (calls[tool] ?? 0) + 1; return (S as any)[tool](); }) }));
const Q = "Expenses related to the treatment of a pre-existing disease (PED) and its direct complications shall be excluded until the expiry of 48 months of continuous coverage";
const S = {
  extract_rejection: () => ({ insurer: "I", policy_no: null, claim_no: null, patient_name: null, claim_amount_inr: 1, rejection_date: null, admission_date: null, policy_start_date: null, diagnosis: null, reason_summary: "x", clause_cited: "Excl01", reason_category: "pre_existing" }),
  write_queries: () => ({ queries: ["pre-existing", "excl01", "waiting"] }),
  assess_case: () => ({ checks: ["C1_CLAUSE_EXISTS","C2_CONDITIONS_HOLD","C3_OVERRIDING_CLAUSE","C4_EXPLICIT_EXCLUSION","C5_FACTS_KNOWN","C6_DOCS_PRESENT"].map((id,i)=>({id,answer:["yes","no","yes","no","yes","yes"][i],rationale:"r",evidence_refs:[]})), ledger: [{ temp_id: "L1", claim: "c", page_id: db.pages.find((p) => p.text.includes("Excl01 — Pre"))!.id, quote: Q }], missing_facts: [] }),
  choose_route: () => ({ reason: "r" }),
  draft_appeal: () => ({ subject: "A", body_md: "Bad cite. [cite:E5]" }),
  redteam_review: () => ({ rebuttal: "x", attacked: [], supporting: [], severity: "high" }),
};
it("traces the redteam loop", async () => {
  const { parsePdf } = await import("@/lib/ingest/pdf");
  const pages = await parsePdf(fs.readFileSync("samples/policy.pdf"));
  db = { cases: [{ id: "c1", owner_id: "o", state: "INTAKE", answers: {}, candidate_page_ids: [], redraft_count: 0, redteam_done: false, sim_offset_days: 0, step_lock_until: null }], documents: [{ id: "dp", case_id: "c1", kind: "policy" }, { id: "dr", case_id: "c1", kind: "rejection" }],
    pages: [...pages.map((p, i) => ({ id: `00000000-0000-4000-a000-00000000000${i + 1}`, document_id: "dp", case_id: "c1", page_no: p.page_no, text: p.text, text_norm: p.text_norm })), { id: "00000000-0000-4000-b000-000000000001", document_id: "dr", case_id: "c1", page_no: 1, text: "rejected Excl01", text_norm: "rejected excl01" }], evidence: [], agent_events: [], drafts: [], followups: [] } as Db;
  const { runStep } = await import("@/lib/agent/machine");
  const seqs: string[] = [];
  for (let i = 0; i < 30; i++) { const before = db.cases[0].state; const r = await runStep("c1"); seqs.push(`${before}->${r.state} (redraft=${db.cases[0].redraft_count}, rt_done=${db.cases[0].redteam_done})`); if (["AWAITING_APPROVAL","ERROR"].includes(r.state)) break; }
  fs.writeFileSync("audit/logs/24-redteam-trace.log", seqs.join("\n") + `\ncalls=${JSON.stringify(calls)}\nfinal body=${JSON.stringify(db.drafts.at(-1)?.body_md)}\n`);
});
