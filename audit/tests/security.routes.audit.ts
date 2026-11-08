// IDOR + input validation against the real route handlers. The cookie owner is
// "attacker"; the case belongs to "victim".
import { it, vi } from "vitest";
import fs from "node:fs";
import { makeClient, type Db } from "./auditFakeDb";

let db: Db; let owner: string | null = "attacker";
vi.mock("@/lib/db", () => ({ supabaseAdmin: () => makeClient(db), getOwnerId: async () => owner, getOrCreateOwnerId: async () => owner ?? "new-owner", DOCUMENTS_BUCKET: "documents" }));
vi.mock("@/lib/models", async (o) => ({ ...(await o<any>()), generate: vi.fn(async () => { throw new Error("model must not be called"); }) }));

const CASE = "11111111-1111-4111-8111-111111111111";
function seed() {
  db = { cases: [{ id: CASE, owner_id: "victim", state: "AWAITING_APPROVAL", answers: {}, sim_offset_days: 0, redraft_count: 0, redteam_done: true, step_lock_until: null, claim_amount_inr: 1 }],
    documents: [{ id: "d1", case_id: CASE, kind: "policy", storage_path: `${CASE}/policy-1-x.pdf` }], pages: [], evidence: [], agent_events: [], drafts: [{ id: "dr", case_id: CASE, version: 1, body_md: "secret" }], followups: [{ id: "f1", case_id: CASE, due_on: "2000-01-01", action: "ESCALATE_BIMA_BHAROSA", status: "pending" }] } as Db;
}
const P = { params: Promise.resolve({ id: CASE }) };
const json = (body: unknown, type = "application/json") => new Request("http://x/", { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) }) as never;

it("IDOR per route + validation", async () => {
  const out: Record<string, unknown> = {};
  const routes: Array<[string, () => Promise<Response>]> = [
    ["GET /api/cases/[id]", async () => (await import("@/app/api/cases/[id]/route")).GET(new Request("http://x") as never, P)],
    ["DELETE /api/cases/[id]", async () => (await import("@/app/api/cases/[id]/route")).DELETE(new Request("http://x", { method: "DELETE" }) as never, P)],
    ["POST step", async () => (await import("@/app/api/cases/[id]/step/route")).POST(json({}), P)],
    ["POST answer", async () => (await import("@/app/api/cases/[id]/answer/route")).POST(json({ answers: { a: "b" } }), P)],
    ["POST approve", async () => (await import("@/app/api/cases/[id]/approve/route")).POST(json({}), P)],
    ["POST simulate", async () => (await import("@/app/api/cases/[id]/simulate/route")).POST(json({ days: 30 }), P)],
    ["POST documents", async () => { const fd = new FormData(); fd.set("kind", "other"); fd.set("text", "hello"); return (await import("@/app/api/cases/[id]/documents/route")).POST(new Request("http://x", { method: "POST", body: fd }) as never, P); }],
  ];
  for (const who of ["attacker", null]) {
    for (const [name, call] of routes) {
      seed(); owner = who; const before = JSON.stringify(db);
      const res = await call();
      out[`${who ?? "no-cookie"} | ${name}`] = { status: res.status, db_unchanged: JSON.stringify(db) === before, body_leaks_victim_data: (await res.text()).includes("secret") };
    }
  }
  // Validation (as the legitimate owner)
  owner = "victim"; const v: Record<string, unknown> = {};
  const create = (await import("@/app/api/cases/route")).POST;
  for (const [n, b, t] of [["negative amount", { claim_amount_inr: -5 }, "application/json"], ["huge amount", { claim_amount_inr: 1e30 }, "application/json"], ["title 10k chars", { title: "x".repeat(10000) }, "application/json"], ["text/plain JSON body", { title: "csrf" }, "text/plain"], ["not json", "{oops", "application/json"]] as const) {
    seed(); const r = await create(json(b, t)); v[`POST /api/cases: ${n}`] = r.status;
  }
  const answer = (await import("@/app/api/cases/[id]/answer/route")).POST;
  seed(); db.cases[0].state = "AWAITING_USER";
  const many = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, "y".repeat(2000)]));
  const r = await answer(json({ answers: many }), P);
  v["POST answer: 2000 keys x 2000 chars (4 MB)"] = { status: r.status, stored_answer_bytes: JSON.stringify(db.cases[0].answers).length };
  const sim = (await import("@/app/api/cases/[id]/simulate/route")).POST;
  for (const d of [0, -1, 3651, 1.5, "10"]) { seed(); db.cases[0].owner_id = "victim"; v[`simulate days=${JSON.stringify(d)}`] = (await sim(json({ days: d }), P)).status; }
  // Document upload: path traversal filename, wrong type, stored path
  const docs = (await import("@/app/api/cases/[id]/documents/route")).POST;
  seed();
  const pdf = fs.readFileSync("audit/repro/fixtures/three_pages.pdf");
  const fd = new FormData(); fd.set("kind", "policy"); fd.set("file", new File([pdf], "../../other-case/evil.pdf", { type: "application/pdf" }));
  const up = await docs(new Request("http://x", { method: "POST", body: fd }) as never, P);
  v["upload with ../ filename"] = { status: up.status, storage_path: db.documents.at(-1)?.storage_path };
  const fd2 = new FormData(); fd2.set("kind", "policy"); fd2.set("file", new File([Buffer.from("MZ\x90\x00 not a pdf")], "x.pdf", { type: "application/pdf" }));
  v["upload exe renamed .pdf"] = (await docs(new Request("http://x", { method: "POST", body: fd2 }) as never, P)).status;
  seed(); db.cases[0].state = "APPROVED";
  const fd3 = new FormData(); fd3.set("kind", "policy"); fd3.set("text", "late document");
  v["upload to an APPROVED case"] = (await docs(new Request("http://x", { method: "POST", body: fd3 }) as never, P)).status;
  // Error responses: do 500s echo internals?
  const getCase = (await import("@/app/api/cases/[id]/route")).GET;
  seed(); const orig = db.cases; (db as any).cases = undefined; Object.defineProperty(db, "cases", { get() { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"); }, configurable: true });
  try { const e = await getCase(new Request("http://x") as never, P); v["GET case when DB throws"] = { status: e.status, body: (await e.text()).slice(0, 150) }; } catch (e) { v["GET case when DB throws"] = { uncaught: String(e).slice(0, 150) }; }
  Object.defineProperty(db, "cases", { value: orig, writable: true });
  fs.writeFileSync("audit/logs/50-security-routes.json", JSON.stringify({ idor: out, validation: v }, null, 2));
});
