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

// Audit F-007: limits must survive dropping the cookie.
describe("per-IP and global limits", () => {
  const req = (ip?: string) =>
    new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(ip ? { "x-forwarded-for": `${ip}, 10.0.0.1` } : {}) },
      body: JSON.stringify({ title: "t" }),
    }) as never;

  it("clientIp takes the first x-forwarded-for entry", async () => {
    const { clientIp } = await import("../lib/rateLimit");
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }))).toBe("203.0.113.7");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "198.51.100.2" } }))).toBe("198.51.100.2");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });

  it("a client that drops its cookie every time is still stopped by the per-IP limit", async () => {
    let n = 0;
    const db = await import("../lib/db");
    const spy = vi.spyOn(db, "getOrCreateOwnerId").mockImplementation(async () => `fresh-owner-${++n}`);
    const { POST } = await import("../app/api/cases/route");
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await POST(req("203.0.113.7"))).status);
    spy.mockRestore();
    expect(statuses.filter((s) => s === 200).length).toBe(20);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    // a different IP is unaffected
    expect((await POST(req("198.51.100.9"))).status).toBe(200);
  });

  it("the global daily LLM budget stops every client once spent", async () => {
    process.env.GLOBAL_DAILY_LLM_CALLS = "3";
    const { enforceRequestLimits } = await import("../lib/rateLimit");
    const now = new Date("2026-01-01T10:00:00Z");
    for (let i = 0; i < 3; i++) await enforceRequestLimits(req(`192.0.2.${i}`), `owner-${i}`, "step", now);
    await expect(enforceRequestLimits(req("192.0.2.99"), "owner-99", "step", now)).rejects.toMatchObject({ status: 429 });
    delete process.env.GLOBAL_DAILY_LLM_CALLS;
  });

  it("uploads, answers and simulate are rate limited too", async () => {
    const { RATE_LIMITS } = await import("../lib/rateLimit");
    for (const b of ["upload", "answer", "simulate", "ip:upload", "ip:answer", "ip:simulate"] as const) expect(RATE_LIMITS[b].limit).toBeGreaterThan(0);
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

  it("defaults to a 60k cap when unset, so a fresh deployment is protected (audit F-007)", async () => {
    delete process.env.MAX_TOKENS_PER_CASE;
    const { tokenBudget, DEFAULT_MAX_TOKENS_PER_CASE } = await import("../lib/agent/machine");
    expect(tokenBudget()).toBe(DEFAULT_MAX_TOKENS_PER_CASE);
    expect(DEFAULT_MAX_TOKENS_PER_CASE).toBe(60_000);
  });

  it("can be disabled explicitly with 0", async () => {
    process.env.MAX_TOKENS_PER_CASE = "0";
    const { tokenBudget } = await import("../lib/agent/machine");
    expect(tokenBudget()).toBeNull();
  });

  it("falls back to the default for a non-numeric value rather than crashing or disabling", async () => {
    process.env.MAX_TOKENS_PER_CASE = "lots";
    const { tokenBudget } = await import("../lib/agent/machine");
    expect(tokenBudget()).toBe(60_000);
  });
});
