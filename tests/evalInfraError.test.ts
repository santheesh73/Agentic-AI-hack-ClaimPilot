import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/db", () => ({ supabaseAdmin: () => ({}) }));

describe("infraErrorOf", () => {
  it("classifies quota, rate-limit and outage errors as infrastructure", async () => {
    const { infraErrorOf } = await import("../evals/run");
    expect(infraErrorOf("Failed after 3 attempts. Last error: AI_APICallError: You exceeded your current quota, please check")).toBe("quota");
    expect(infraErrorOf("429 Too Many Requests")).toBe("quota");
    expect(infraErrorOf("503 The model is overloaded")).toBe("provider_unavailable");
    expect(infraErrorOf("TypeError: fetch failed")).toBe("provider_unavailable");
    // seen live: Gemini's overload message carries no status code or the word "overloaded"
    expect(infraErrorOf("Failed after 3 attempts. Last error: AI_APICallError: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.")).toBe("provider_unavailable");
  });
  it("does not excuse real pipeline errors", async () => {
    const { infraErrorOf } = await import("../evals/run");
    expect(infraErrorOf("No policy text could be verified for this case, so no appeal letter was drafted.")).toBeUndefined();
    expect(infraErrorOf('duplicate key value violates unique constraint "evidence_case_id_short_id_key"')).toBeUndefined();
    expect(infraErrorOf(null)).toBeUndefined();
  });
});
