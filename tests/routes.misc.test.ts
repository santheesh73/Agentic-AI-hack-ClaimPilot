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

// /api/health calls getEnv() for real; the test runner doesn't load
// .env.local the way `next dev`/`next build` do, so this would otherwise
// fail on missing vars regardless of the DB/storage checks under test.
vi.mock("../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/env")>();
  return {
    ...actual,
    getEnv: () => ({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "key",
      LLM_PROVIDER: "google" as const,
      GEMINI_API_KEY: "key",
    }),
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
  fakeDb = {};
  resetFakeIds();
  setFakeOwner("owner-1");
});

describe("POST /api/cases/[id]/answer", () => {
  beforeEach(() => {
    fakeDb.cases = [
      { id: "case-1", owner_id: "owner-1", state: "AWAITING_USER", answers: {} },
    ];
    fakeDb.agent_events = [];
  });

  it("merges answers and resumes at ASSESS", async () => {
    const { POST } = await import("../app/api/cases/[id]/answer/route");
    const res = await POST(jsonRequest({ answers: { diagnosis_date: "March 2025" } }) as never, {
      params: Promise.resolve({ id: "case-1" }),
    });
    expect(res.status).toBe(200);
    const updated = fakeDb.cases.find((c) => c.id === "case-1")!;
    expect(updated.state).toBe("ASSESS");
    expect((updated.answers as Record<string, string>).diagnosis_date).toBe("March 2025");
  });

  it("rejects a body without an answers object", async () => {
    const { POST } = await import("../app/api/cases/[id]/answer/route");
    const res = await POST(jsonRequest({}) as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent case", async () => {
    fakeDb.cases = [];
    const { POST } = await import("../app/api/cases/[id]/answer/route");
    const res = await POST(jsonRequest({ answers: { a: "b" } }) as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/cases/[id]/approve", () => {
  it("approves a case in AWAITING_APPROVAL and schedules follow-ups", async () => {
    fakeDb.cases = [
      {
        id: "case-1",
        owner_id: "owner-1",
        state: "AWAITING_APPROVAL",
        sim_offset_days: 0,
        claim_amount_inr: 100000,
        facts: { insurer: "Test Insurer" },
      },
    ];
    fakeDb.drafts = [];
    fakeDb.followups = [];
    fakeDb.agent_events = [];

    const { POST } = await import("../app/api/cases/[id]/approve/route");
    const res = await POST({} as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(200);

    const updated = fakeDb.cases.find((c) => c.id === "case-1")!;
    expect(updated.state).toBe("APPROVED");
    expect(updated.complaint_sent_on).toBeTruthy();
    expect(fakeDb.followups.length).toBeGreaterThan(0);
  });

  it("rejects approving a case not in AWAITING_APPROVAL", async () => {
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-1", state: "DRAFT" }];
    const { POST } = await import("../app/api/cases/[id]/approve/route");
    const res = await POST({} as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_state");
  });
});

describe("POST /api/cases/sample", () => {
  it("creates a case from the real samples/ files for a valid sample id", async () => {
    fakeDb.cases = [];
    fakeDb.documents = [];
    fakeDb.pages = [];
    const { POST } = await import("../app/api/cases/sample/route");
    const res = await POST(jsonRequest({ sample: "a" }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBeDefined();
    expect(fakeDb.documents.filter((d) => d.case_id === json.id).length).toBe(2); // policy + rejection
  });

  it("rejects an unknown sample id", async () => {
    const { POST } = await import("../app/api/cases/sample/route");
    const res = await POST(jsonRequest({ sample: "z" }) as never);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/health", () => {
  it("reports ok when the DB and storage checks succeed", async () => {
    fakeDb.regulations = [{ id: "GRO_14D" }];
    const { GET } = await import("../app/api/health/route");
    const res = await GET();
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.provider).toBe("google");
    expect(res.status).toBe(200);
  });
});
