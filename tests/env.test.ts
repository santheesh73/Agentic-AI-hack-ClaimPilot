import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, _resetEnvCacheForTests } from "../lib/env";

const BASE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("getEnv", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    _resetEnvCacheForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetEnvCacheForTests();
  });

  it("throws a single readable error listing every missing var", () => {
    process.env = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(() => getEnv()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("requires GEMINI_API_KEY when LLM_PROVIDER=google (the default)", () => {
    process.env = { ...BASE } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/GEMINI_API_KEY/);
  });

  it("requires ANTHROPIC_API_KEY when LLM_PROVIDER=anthropic", () => {
    process.env = { ...BASE, LLM_PROVIDER: "anthropic" } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("succeeds with a complete google config and defaults LLM_PROVIDER", () => {
    process.env = { ...BASE, GEMINI_API_KEY: "key" } as unknown as NodeJS.ProcessEnv;
    const env = getEnv();
    expect(env.LLM_PROVIDER).toBe("google");
  });

  it("succeeds with a complete anthropic config", () => {
    process.env = { ...BASE, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key" } as unknown as NodeJS.ProcessEnv;
    const env = getEnv();
    expect(env.LLM_PROVIDER).toBe("anthropic");
  });

  it("rejects a non-numeric MAX_TOKENS_PER_CASE", () => {
    process.env = { ...BASE, GEMINI_API_KEY: "key", MAX_TOKENS_PER_CASE: "not-a-number" } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow();
  });

  it("caches the result across calls", () => {
    process.env = { ...BASE, GEMINI_API_KEY: "key" } as unknown as NodeJS.ProcessEnv;
    const first = getEnv();
    process.env.GEMINI_API_KEY = undefined;
    const second = getEnv();
    expect(second).toBe(first);
  });
});
