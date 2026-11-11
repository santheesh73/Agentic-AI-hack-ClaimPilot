// Audit F-010: our own retry policy must be the only one. Before the fix the AI SDK retried
// each of our attempts 2 more times (6 provider calls per 429), and a 401 was retried as a
// "schema failure".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";

let doGenerateCalls = 0;
let behaviour: () => Promise<unknown>;
vi.mock("../lib/db", () => ({ supabaseAdmin: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => new MockLanguageModelV4({ doGenerate: async () => { doGenerateCalls++; return behaviour() as never; } }),
}));

const ok = (text: string) => async () => ({
  content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
});
const httpErr = (status: number) => async () => {
  throw new APICallError({ message: `HTTP ${status}`, url: "https://x", requestBodyValues: {}, statusCode: status, isRetryable: status === 429 || status >= 500 });
};
const schema = z.object({ v: z.enum(["A", "B"]) });
const run = async () => {
  const { generate } = await import("../lib/models");
  return generate({ caseId: "c", step: "S", tool: "t", model: "m", schema, system: "s", prompt: "p" });
};

beforeEach(() => { doGenerateCalls = 0; vi.useRealTimers(); });

describe("generate() retry policy", () => {
  it("a valid response takes exactly one provider call", async () => {
    behaviour = ok('{"v":"A"}');
    await expect(run()).resolves.toEqual({ v: "A" });
    expect(doGenerateCalls).toBe(1);
  });

  it("a 429 makes exactly 3 provider calls (our 3 attempts), not 6", async () => {
    behaviour = httpErr(429);
    await expect(run()).rejects.toThrow();
    expect(doGenerateCalls).toBe(3);
  }, 15_000);

  it("a 503 makes exactly 3 provider calls", async () => {
    behaviour = httpErr(503);
    await expect(run()).rejects.toThrow();
    expect(doGenerateCalls).toBe(3);
  }, 15_000);

  it("a 401 is not retried at all", async () => {
    behaviour = httpErr(401);
    await expect(run()).rejects.toThrow();
    expect(doGenerateCalls).toBe(1);
  });

  it("a response that doesn't match the schema gets exactly one retry", async () => {
    behaviour = ok('{"v":"C"}');
    await expect(run()).rejects.toThrow();
    expect(doGenerateCalls).toBe(2);
  });
});
