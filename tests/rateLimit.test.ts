import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

beforeEach(() => {
  fakeDb = { cases: [], agent_events: [] };
  resetFakeIds();
  setFakeOwner("owner-1");
});

describe("windowStart", () => {
  it("buckets every timestamp in the same minute to the same window", async () => {
    const { windowStart } = await import("../lib/rateLimit");
    const a = windowStart(new Date("2026-01-01T10:00:05Z"), 60_000);
    const b = windowStart(new Date("2026-01-01T10:00:59Z"), 60_000);
    const c = windowStart(new Date("2026-01-01T10:01:00Z"), 60_000);
    expect(a).toBe(b);
    expect(a).toBe("2026-01-01T10:00:00.000Z");
    expect(c).not.toBe(a);
  });
});

describe("enforceRateLimit", () => {
  it("allows exactly 30 /step calls per minute and rejects the 31st with a 429", async () => {
    const { enforceRateLimit } = await import("../lib/rateLimit");
    const now = new Date("2026-01-01T10:00:00Z");
    for (let i = 0; i < 30; i++) await enforceRateLimit("owner-1", "step", now);
    await expect(enforceRateLimit("owner-1", "step", now)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("resets in the next window", async () => {
    const { enforceRateLimit } = await import("../lib/rateLimit");
    const t0 = new Date("2026-01-01T10:00:00Z");
    for (let i = 0; i < 30; i++) await enforceRateLimit("owner-1", "step", t0);
    await expect(enforceRateLimit("owner-1", "step", new Date("2026-01-01T10:01:00Z"))).resolves.toBeUndefined();
  });

  it("counts each owner separately", async () => {
    const { enforceRateLimit } = await import("../lib/rateLimit");
    const now = new Date("2026-01-01T10:00:00Z");
    for (let i = 0; i < 30; i++) await enforceRateLimit("owner-1", "step", now);
    await expect(enforceRateLimit("owner-2", "step", now)).resolves.toBeUndefined();
  });
});

describe("POST /api/cases rate limit", () => {
  it("allows 10 new cases per hour, then returns 429 with the standard error shape", async () => {
    const { POST } = await import("../app/api/cases/route");
    const req = () =>
      new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "t" }),
      }) as never;

    for (let i = 0; i < 10; i++) expect((await POST(req())).status).toBe(200);
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(fakeDb.cases.length).toBe(10); // the rejected request created nothing
  });
});

describe("MAX_TOKENS_PER_CASE", () => {
  const original = process.env.MAX_TOKENS_PER_CASE;
  afterEach(() => {
    if (original === undefined) delete process.env.MAX_TOKENS_PER_CASE;
    else process.env.MAX_TOKENS_PER_CASE = original;
  });

  it("sets ERROR with a clear message once a case has used its budget", async () => {
    process.env.MAX_TOKENS_PER_CASE = "1000";
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-1", state: "EXTRACT", step_lock_until: null, error: null }];
    fakeDb.agent_events = [
      { id: "1", case_id: "case-1", tool: "extract_rejection", tokens_in: 700, tokens_out: 400 },
    ];
    const { runStep } = await import("../lib/agent/machine");
    const result = await runStep("case-1");
    expect(result.state).toBe("ERROR");
    expect(fakeDb.cases[0].error).toMatch(/Token budget exceeded \(1100 of 1000/);
  });

  it("is ignored when unset", async () => {
    delete process.env.MAX_TOKENS_PER_CASE;
    const { tokenBudget } = await import("../lib/agent/machine");
    expect(tokenBudget()).toBeNull();
  });

  it("ignores a non-numeric value rather than crashing", async () => {
    process.env.MAX_TOKENS_PER_CASE = "lots";
    const { tokenBudget } = await import("../lib/agent/machine");
    expect(tokenBudget()).toBeNull();
  });
});
