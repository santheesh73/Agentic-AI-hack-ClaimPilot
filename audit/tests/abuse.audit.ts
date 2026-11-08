import { it, vi } from "vitest";
import fs from "node:fs";
import { makeClient, type Db } from "./auditFakeDb";
let db: Db; let n = 0; let mode: "fresh-cookie-each-time" | "same-cookie" = "same-cookie";
vi.mock("@/lib/db", () => ({ supabaseAdmin: () => makeClient(db), getOwnerId: async () => "victim", getOrCreateOwnerId: async () => (mode === "same-cookie" ? "same" : `fresh-${++n}`), DOCUMENTS_BUCKET: "documents" }));
let gen = 0;
vi.mock("@/lib/models", async (o) => ({ ...(await o<any>()), generate: vi.fn(async () => { gen++; await new Promise((r) => setTimeout(r, 5)); return { subject: "s", body_md: "Escalation text." }; }) }));
const CASE = "22222222-2222-4222-8222-222222222222";
const post = (b: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }) as never;
it("abuse, delete completeness, simulate race", async () => {
  const out: Record<string, unknown> = {};
  const create = (await import("@/app/api/cases/route")).POST;
  for (const m of ["same-cookie", "fresh-cookie-each-time"] as const) {
    mode = m; db = { cases: [], rate_limits: [] } as Db; const codes: number[] = [];
    for (let i = 0; i < 50; i++) codes.push((await create(post({ title: "t" }))).status);
    out[`50 x POST /api/cases (${m})`] = { created: db.cases.length, http429: codes.filter((c) => c === 429).length };
  }
  // DELETE removes every row for the case (FK cascade emulated by the route? check what the route itself deletes)
  db = { cases: [{ id: CASE, owner_id: "victim" }], documents: [{ id: "d", case_id: CASE, storage_path: `${CASE}/p.pdf` }], pages: [{ id: "p", case_id: CASE, document_id: "d" }], evidence: [{ id: "e", case_id: CASE }], agent_events: [{ id: 1, case_id: CASE }], drafts: [{ id: "dr", case_id: CASE }], followups: [{ id: "f", case_id: CASE }] } as Db;
  const del = (await import("@/app/api/cases/[id]/route")).DELETE;
  const r = await del(new Request("http://x", { method: "DELETE" }) as never, { params: Promise.resolve({ id: CASE }) });
  out.delete = { status: r.status, storage_ops: db.__storage, rows_left_by_table: Object.fromEntries(["cases", "documents", "pages", "evidence", "agent_events", "drafts", "followups"].map((t) => [t, (db[t] ?? []).filter((x) => x.case_id === CASE || x.id === CASE).length])), note: "child rows rely on ON DELETE CASCADE in Postgres (supabase/migrations/0001_init.sql); the route deletes only the cases row" };
  // simulate: two concurrent calls on the same due followup
  db = { cases: [{ id: CASE, owner_id: "victim", sim_offset_days: 0, facts: {} }], followups: [{ id: "f1", case_id: CASE, due_on: "2000-01-01", action: "ESCALATE_BIMA_BHAROSA", status: "pending" }], evidence: [], pages: [], agent_events: [] } as Db;
  const sim = (await import("@/app/api/cases/[id]/simulate/route")).POST;
  gen = 0;
  const [a, b] = await Promise.all([sim(post({ days: 15 }), { params: Promise.resolve({ id: CASE }) }), sim(post({ days: 15 }), { params: Promise.resolve({ id: CASE }) })]);
  out.simulate_race = { statuses: [a.status, b.status], escalation_llm_calls: gen, final_sim_offset_days: db.cases[0].sim_offset_days, expected_offset_if_serialized: 30, fired_events: db.agent_events.filter((e) => e.step === "SIMULATE").length };
  fs.writeFileSync("audit/logs/58-abuse-delete-simulate.json", JSON.stringify(out, null, 2));
});
