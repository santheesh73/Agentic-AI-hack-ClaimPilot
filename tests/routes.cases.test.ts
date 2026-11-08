import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, resetFakeIds, type FakeDb } from "./helpers/fakeSupabase";
import { setFakeOwner, fakeGetOwnerId, fakeGetOrCreateOwnerId } from "./helpers/fakeOwnerCookie";

let fakeDb: FakeDb;

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    supabaseAdmin: () => createFakeSupabase(fakeDb),
    getOwnerId: fakeGetOwnerId,
    getOrCreateOwnerId: fakeGetOrCreateOwnerId,
  };
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  fakeDb = { cases: [] };
  resetFakeIds();
  setFakeOwner("owner-1");
});

describe("POST /api/cases", () => {
  it("creates a case for the current owner on a valid body", async () => {
    const { POST } = await import("../app/api/cases/route");
    const res = await POST(jsonRequest({ title: "My case", claim_amount_inr: 50000 }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBeDefined();
    expect(fakeDb.cases.find((c) => c.id === json.id)?.owner_id).toBe("owner-1");
  });

  it("returns 400 with a structured error on a negative claim amount", async () => {
    const { POST } = await import("../app/api/cases/route");
    const res = await POST(jsonRequest({ claim_amount_inr: -100 }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_body");
  });

  it("returns 400 on malformed JSON", async () => {
    const { POST } = await import("../app/api/cases/route");
    const req = new Request("http://localhost/test", { method: "POST", body: "{not json" });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_json");
  });
});

describe("GET /api/cases/[id]", () => {
  function seedOwnedCase(ownerId: string) {
    fakeDb.cases = [
      {
        id: "case-1",
        owner_id: ownerId,
        title: "t",
        state: "INTAKE",
        complaint_sent_on: null,
        claim_amount_inr: null,
      },
    ];
    fakeDb.agent_events = [];
    fakeDb.evidence = [];
    fakeDb.drafts = [];
    fakeDb.followups = [];
    fakeDb.documents = [];
    fakeDb.pages = [];
  }

  it("returns the case for its owner", async () => {
    seedOwnedCase("owner-1");
    const { GET } = await import("../app/api/cases/[id]/route");
    const res = await GET({} as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.case.id).toBe("case-1");
  });

  it("returns 404 (not 403) for a case owned by a different browser", async () => {
    seedOwnedCase("owner-2");
    setFakeOwner("owner-1");
    const { GET } = await import("../app/api/cases/[id]/route");
    const res = await GET({} as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("not_found");
  });

  it("returns 404 for a nonexistent case id", async () => {
    fakeDb.cases = [];
    const { GET } = await import("../app/api/cases/[id]/route");
    const res = await GET({} as never, { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/cases/[id]/step", () => {
  it("returns 409 when a step is already in progress for the case", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    fakeDb.cases = [
      { id: "case-1", owner_id: "owner-1", state: "INTAKE", step_lock_until: future },
    ];
    fakeDb.agent_events = [];
    const { POST } = await import("../app/api/cases/[id]/step/route");
    const res = await POST({} as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("step_in_progress");
    expect(json.state).toBe("INTAKE");
  });

  it("returns 404 for a case owned by someone else", async () => {
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-2", state: "INTAKE", step_lock_until: null }];
    const { POST } = await import("../app/api/cases/[id]/step/route");
    const res = await POST({} as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/cases/[id]/simulate", () => {
  beforeEach(() => {
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-1", state: "APPROVED", sim_offset_days: 0, facts: null }];
    fakeDb.followups = [];
  });

  it("rejects a non-positive days value", async () => {
    const { POST } = await import("../app/api/cases/[id]/simulate/route");
    const res = await POST(jsonRequest({ days: 0 }) as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(400);
  });

  it("advances sim_offset_days on a valid request", async () => {
    const { POST } = await import("../app/api/cases/[id]/simulate/route");
    const res = await POST(jsonRequest({ days: 15 }) as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sim_offset_days).toBe(15);
  });
});
