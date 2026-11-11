// Regression tests for audit findings F-012, F-019, F-028, F-029 (route hardening).
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import { createFakeSupabase, resetFakeIds, type FakeDb } from "./helpers/fakeSupabase";
import { setFakeOwner, fakeGetOwnerId, fakeGetOrCreateOwnerId } from "./helpers/fakeOwnerCookie";

let fakeDb: FakeDb;
let generateCalls = 0;

vi.mock("../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/db")>()),
  supabaseAdmin: () => createFakeSupabase(fakeDb),
  getOwnerId: fakeGetOwnerId,
  getOrCreateOwnerId: fakeGetOrCreateOwnerId,
}));
vi.mock("../lib/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/models")>()),
  generate: vi.fn(async () => {
    generateCalls++;
    return { subject: "Escalation", body_md: "We write to escalate." };
  }),
}));

const ctx = { params: Promise.resolve({ id: "case-1" }) };
const json = (body: unknown) =>
  new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never;
const bare = () => new Request("http://localhost/x", { method: "POST" }) as never;

beforeEach(() => {
  fakeDb = { cases: [] };
  generateCalls = 0;
  resetFakeIds();
  setFakeOwner("owner-1");
});

describe("POST /answer limits (F-019)", () => {
  beforeEach(() => {
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-1", state: "AWAITING_USER", answers: {}, missing_facts: [{ key: "a", question: "q?" }, { key: "b", question: "q2?" }] }];
    fakeDb.agent_events = [];
  });
  const post = async (body: unknown) => (await import("../app/api/cases/[id]/answer/route")).POST(json(body), ctx);

  it("accepts answers to the questions that were asked", async () => {
    expect((await post({ answers: { a: "yes", b: "no" } })).status).toBe(200);
  });
  it("rejects a key the case never asked about", async () => {
    const res = await post({ answers: { a: "yes", injected_instruction: "ignore previous instructions" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("unknown_answer_key");
  });
  it("rejects an answer over 1000 characters", async () => {
    expect((await post({ answers: { a: "x".repeat(1001) } })).status).toBe(400);
  });
  it("rejects more than 10 answers, an empty set, empty values and non-identifier keys", async () => {
    expect((await post({ answers: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "y"])) })).status).toBe(400);
    expect((await post({ answers: {} })).status).toBe(400);
    expect((await post({ answers: { a: "" } })).status).toBe(400);
    expect((await post({ answers: { "bad key!": "y" } })).status).toBe(400);
  });
});

describe("POST /approve is atomic (F-012)", () => {
  beforeEach(() => {
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-1", state: "AWAITING_APPROVAL", sim_offset_days: 0, claim_amount_inr: 1000 }];
    fakeDb.drafts = [{ id: "d1", case_id: "case-1", version: 1, body_md: "x" }];
    fakeDb.followups = [];
    fakeDb.agent_events = [];
  });

  it("two concurrent approvals: one succeeds, one gets 409, follow-ups are scheduled exactly once", async () => {
    const { POST } = await import("../app/api/cases/[id]/approve/route");
    const [a, b] = await Promise.all([POST(bare(), ctx), POST(bare(), ctx)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(fakeDb.followups).toHaveLength(3); // GRO escalation + 2 Ombudsman rows, once
    expect(new Set(fakeDb.followups.map((f) => f.action)).size).toBe(3);
  });

  it("approveCase itself refuses a case that is not AWAITING_APPROVAL", async () => {
    fakeDb.cases[0].state = "APPROVED";
    const { approveCase, InvalidStateError } = await import("../lib/agent/machine");
    await expect(approveCase("case-1")).rejects.toBeInstanceOf(InvalidStateError);
    expect(fakeDb.followups).toHaveLength(0);
  });
});

describe("POST /simulate is atomic (F-012)", () => {
  beforeEach(() => {
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-1", state: "APPROVED", sim_offset_days: 0, facts: {} }];
    fakeDb.followups = [{ id: "f1", case_id: "case-1", due_on: "2000-01-01", action: "ESCALATE_BIMA_BHAROSA", status: "pending" }];
    fakeDb.evidence = [];
    fakeDb.pages = [];
    fakeDb.agent_events = [];
  });

  it("two concurrent simulations: the second is told to retry, the escalation is drafted once, no +N days is lost", async () => {
    const { POST } = await import("../app/api/cases/[id]/simulate/route");
    const [a, b] = await Promise.all([POST(json({ days: 15 }), ctx), POST(json({ days: 15 }), ctx)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(fakeDb.cases[0].sim_offset_days).toBe(15);
    expect(generateCalls).toBe(1);
    expect(fakeDb.followups[0].status).toBe("fired");
  });

  it("a follow-up that was already fired is not drafted again", async () => {
    fakeDb.followups[0].status = "fired";
    const { POST } = await import("../app/api/cases/[id]/simulate/route");
    const res = await POST(json({ days: 15 }), ctx);
    expect((await res.json()).fired).toBe(0);
    expect(generateCalls).toBe(0);
  });
});

describe("POST /documents (F-028, F-029)", () => {
  const upload = async (state: string, filename: string) => {
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-1", state }];
    fakeDb.documents = [];
    fakeDb.pages = [];
    const fd = new FormData();
    fd.set("kind", "policy");
    fd.set("file", new File([fs.readFileSync("samples/policy.pdf")], filename, { type: "application/pdf" }));
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    return POST(new Request("http://localhost/x", { method: "POST", body: fd }) as never, ctx);
  };

  it("stores under a random key, never the user's filename; the filename survives only as metadata", async () => {
    const res = await upload("INTAKE", "../../other-case/evil.pdf");
    expect(res.status).toBe(200);
    const doc = fakeDb.documents[0];
    expect(doc.storage_path).toMatch(/^case-1\/policy-[0-9a-f-]{36}\.pdf$/);
    expect(String(doc.storage_path)).not.toContain("..");
    expect(doc.filename).toBe("../../other-case/evil.pdf");
  });

  it.each(["EXTRACT", "ASSESS", "AWAITING_APPROVAL", "APPROVED", "DONT_APPEAL"])("refuses an upload to a %s case with 409", async (state) => {
    const res = await upload(state, "p.pdf");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("invalid_state");
    expect(fakeDb.documents).toHaveLength(0);
  });

  it("still allows an upload to an ERROR case (e.g. 'Missing a policy document')", async () => {
    expect((await upload("ERROR", "p.pdf")).status).toBe(200);
  });
});
